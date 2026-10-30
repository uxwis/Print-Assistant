import {build} from 'esbuild'
import {Script,createContext} from 'node:vm'
import assert from 'node:assert/strict'

const presetBuild=await build({entryPoints:['src/ui/sizeDrafts.ts'],bundle:true,format:'iife',globalName:'draftsApi',write:false})
const presetContext=createContext({})
new Script(presetBuild.outputFiles[0].text).runInContext(presetContext)
const {fillMatchingPresets,changeSize}=presetContext.draftsApi
const info=(id,w,h,status='unset',printSize)=>({id,name:id,widthPx:w,heightPx:h,printSizeStatus:status,printSize})
const presetFrames=[info('card',900,540),info('portrait',540,900),info('a4',595,842),info('rotated',842,595),info('scaled',2100,2970),info('custom',780,500),info('saved',900,540,'valid',{widthMm:180,heightMm:108}),info('stale',595,842,'stale',{widthMm:210,heightMm:297})]
const auto=fillMatchingPresets(presetFrames,{})
for(const [id,w,h] of [['card','90','54'],['portrait','54','90'],['a4','210','297'],['rotated','297','210'],['scaled','210','297']]) {
 assert.equal(auto[id].width,w);assert.equal(auto[id].height,h);assert(auto[id].automatic)
}
for(const id of ['custom','saved','stale'])assert.equal(auto[id],undefined)
const edited=changeSize(presetFrames[0],'180','width',false,auto.card)
assert.equal(fillMatchingPresets([presetFrames[0]],{card:edited}).card.width,'180','manual entry survives selection refresh')
const cleared=changeSize(presetFrames[0],'','width',false,auto.card)
assert.equal(fillMatchingPresets([presetFrames[0]],{card:cleared}).card.width,'','cleared custom input stays empty')
assert.equal(fillMatchingPresets([info('card',780,500)],auto).card,undefined,'changed unmatched geometry removes only automatic drafts')
assert.equal(fillMatchingPresets([info('card',540,900)],auto).card.width,'54','automatic suggestions follow changed orientation')
assert.equal(auto.card.width,'90','previous state stays immutable')

// Exercise the real message dispatcher, replacing only expensive PDF generation.
const built=await build({entryPoints:['src/code.ts'],bundle:true,platform:'browser',write:false,
 define:{__html__:JSON.stringify('<html></html>')},plugins:[{name:'capture-export',setup(build){
  build.onResolve({filter:/^\.\/plugin\/export$/},()=>({path:'exports',namespace:'test'}))
  build.onLoad({filter:/.*/,namespace:'test'},()=>({contents:`
   export async function exportCmykImages(target,dpi,config){globalThis.exportCalls.push({target,dpi,config,mode:'raster'});return []}
   export async function exportCmykVectorPages(target,dpi,config){globalThis.exportCalls.push({target,dpi,config,mode:'vector'});return []}
   export async function exportVectorPdfPages(){return []}
   export async function exportPngImages(){return []}
  `}))
 }}]})
const messages=[],exportCalls=[],dataKey='printAssistant.size.v1'
let writes=0,failWrite=false
const page={type:'PAGE',children:[],selection:[],loadAsync:async()=>{},on(){},off(){}}
function frame(id,width,height,size) {
 const data=size ? {[dataKey]:JSON.stringify({version:1,...size,widthPx:width,heightPx:height})} : {}
 const node={id,name:id,type:'FRAME',width,height,parent:page,visible:true,children:[],resizeCount:0,rescaleCount:0,cloneCount:0,
  getPluginData:key=>data[key]||'',setPluginData(key,value){if(failWrite && id==='B')throw new Error('write failed');writes++;data[key]=value},
  resizeWithoutConstraints(w,h){this.resizeCount++;this.width=w;this.height=h},rescale(k){this.rescaleCount++;this.width*=k;this.height*=k;for(const child of this.children)for(const key of ['width','height','x','y','strokeWeight'])child[key]*=k},
  clone(){this.cloneCount++;return frame(`copy-${id}`,this.width,this.height)},remove(){page.children.splice(page.children.indexOf(this),1)}}
 page.children.push(node);return node
}
const a=frame('A',900,540,{widthMm:90,heightMm:54}),b=frame('B',500,500,{widthMm:50,heightMm:50}),c=frame('C',400,800)
const nodes=new Map(page.children.map(node=>[node.id,node]))
const figma={currentPage:page,ui:{postMessage:message=>messages.push(message)},showUI(){},on(){},off(){},getNodeByIdAsync:async id=>nodes.get(id)}
new Script(built.outputFiles[0].text).runInContext(createContext({figma,exportCalls,console,Uint8Array,Symbol,setTimeout,clearTimeout}))
const update=(node,widthMm,heightMm)=>({frameId:node.id,widthPx:node.width,heightPx:node.height,widthMm,heightMm})
let requestId=0
async function save(updates,options) {
 await figma.ui.onmessage({type:'set-print-sizes',payload:{requestId:++requestId,updates,options}})
 const result=messages.filter(message=>message.type==='print-sizes-result').at(-1).payload
 assert.equal(result.requestId,requestId);return result
}
const saved=node=>JSON.parse(node.getPluginData(dataKey))
const beforeA=a.getPluginData(dataKey),beforeB=b.getPluginData(dataKey)
let result=await save([update(a,180,108),update(b,NaN,50)])
assert.equal(result.frameIds.length,0);assert.equal(result.errors[0].frameId,'B');assert.equal(writes,0)
assert.equal(a.getPluginData(dataKey),beforeA);assert.equal(b.getPluginData(dataKey),beforeB)
result=await save([update(a,180,108),update(b,80,50)])
assert.match(result.errors[0].message,/比例/);assert.equal(writes,0)
const stale=update(b,80,80);b.width=600
result=await save([update(a,180,108),stale])
assert.equal(result.errors[0].frameId,'B');assert.match(result.errors[0].message,/尺寸已变化/);assert.equal(writes,0)
b.width=500
result=await save([update(a,180,108),{...update(b,80,80),frameId:'missing'}])
assert.match(result.errors[0].message,/未找到/);assert.equal(writes,0)
b.setPluginData('isPrintPlate','true');writes=0
result=await save([update(a,180,108),update(b,80,80)]);assert.match(result.errors[0].message,/原稿/);assert.equal(writes,0)
b.setPluginData('isPrintPlate','');writes=0
// A document edit while node resolution is pending must also reject the whole batch.
figma.getNodeByIdAsync=async id=>{if(id==='B')b.height=600;return nodes.get(id)}
result=await save([update(a,180,108),update(b,80,80)]);assert.equal(writes,0);assert.match(result.errors[0].message,/尺寸已变化/)
b.height=500;figma.getNodeByIdAsync=async id=>nodes.get(id)
failWrite=true;result=await save([update(a,180,108),update(b,80,80)]);failWrite=false
assert.equal(result.errors[0].frameId,'B');assert.equal(a.getPluginData(dataKey),beforeA);assert.equal(b.getPluginData(dataKey),beforeB)
result=await save([update(a,180,108),update(b,80,80)])
assert.equal(result.errors.length,0);assert.equal(result.frameIds.join(','),'A,B')
assert.equal(saved(a).widthMm,180);assert.equal(saved(b).widthMm,80);assert.equal(c.getPluginData(dataKey),'')
assert.equal(a.width,900);assert.equal(a.height,540);assert.equal(b.width,500)
await figma.ui.onmessage({type:'get-frame-info',payload:{target:'selection'}})
page.selection=[a,b]
await figma.ui.onmessage({type:'get-frame-info',payload:{target:'selection'}})
const infos=messages.at(-1).payload.frames
assert.equal(infos.length,2);assert.equal(infos[0].printSizeStatus,'valid');assert.equal(infos[1].printSize.widthMm,80)
for(const mode of ['vector','raster']) {
 await figma.ui.onmessage({type:'export-cmyk',payload:{target:'page',dpi:300,mode,config:{bleed:3}}})
 assert.equal(exportCalls.at(-1).target,'selection');assert.equal(exportCalls.at(-1).mode,mode)
}
page.selection=[];const count=exportCalls.length
for(const mode of ['vector','raster']) {
 await figma.ui.onmessage({type:'export-cmyk',payload:{target:'page',dpi:300,mode,config:{}}})
 assert.equal(messages.at(-1).type,'error');assert.match(messages.at(-1).payload.message,/选中/)
}
assert.equal(exportCalls.length,count)
const a4=frame('A4',595,842);nodes.set(a4.id,a4)
a4.children.push({type:'RECTANGLE',width:200,height:100,x:40,y:20,strokeWeight:2})
result=await save([update(a4,210,297)])
assert.equal(result.errors.length,0);assert.equal(saved(a4).heightMm,297);assert.equal(a4.width,595)
result=await save([update(a4,420,594)])
assert.equal(result.errors.length,0);assert.equal(saved(a4).heightMm,594)
const originalCount=page.children.length
result=await save([update(a4,90,54),update(b,-10,50)],{resizeOriginal:true,scaleContent:true})
assert.equal(result.frameIds.length,0);assert.equal(a4.width,595)
failWrite=true;result=await save([update(a4,90,54),update(b,100,60)],{resizeOriginal:true,scaleContent:true});failWrite=false
assert.equal(result.errors[0].frameId,'B');assert.equal(a4.width,595);assert.equal(a4.height,842);assert.equal(saved(a4).heightMm,594)
assert(Math.abs(a4.children[0].width-200)<1e-8,'failed batch restores content as well as the frame')
result=await save([update(a4,90,54),update(b,100,60)],{resizeOriginal:true,scaleContent:true})
assert.equal(result.errors.length,0);assert.equal(a4.width,595);assert.equal(a4.height,357)
assert.equal(b.width,500);assert.equal(b.height,300)
assert(Math.abs(a4.children[0].width-200*357/842)<1e-8)
assert(Math.abs(a4.children[0].height-100*357/842)<1e-8,'content stays proportional')
assert.equal(saved(a4).widthMm,90);assert.equal(page.children.length,originalCount,'resize probes cleaned up')
// The design scale may be 1 px/mm, 10 px/mm, or the standard point scale.
// Matching proportions must never touch artwork, even with both options enabled.
for(const [id,w,h,mmW,mmH] of [['large',3000,2500,3000,2500],['ten',900,540,180,108],['rounded',595,842,210,297]]) {
 const node=frame(id,w,h);nodes.set(id,node)
 node.children.push({type:'RECTANGLE',width:200,height:100,x:40,y:20,strokeWeight:2})
 const content=JSON.stringify(node.children)
 for(const scaleContent of [false,true]) {
  result=await save([update(node,mmW,mmH)],{resizeOriginal:true,scaleContent})
  assert.equal(result.errors.length,0);assert.equal(node.width,w);assert.equal(node.height,h)
  assert.equal(saved(node).widthMm,mmW);assert.equal(saved(node).heightMm,mmH)
  assert.equal(node.resizeCount,0);assert.equal(node.rescaleCount,0);assert.equal(node.cloneCount,0)
  assert.equal(JSON.stringify(node.children),content,'matching ratio leaves all content unchanged')
 }
}
// Arbitrary aspect ratios are rounded in design pixels, independent of mm size.
const custom=frame('custom',1000,800);nodes.set(custom.id,custom)
custom.children.push({type:'RECTANGLE',width:200,height:100,x:40,y:20,strokeWeight:2})
const customContent=JSON.stringify(custom.children)
result=await save([update(custom,3000,2000)],{resizeOriginal:true,scaleContent:false})
assert.equal(result.errors.length,0);assert.equal(custom.width,1000);assert.equal(custom.height,667)
assert.equal(JSON.stringify(custom.children),customContent,'unchecked scaling preserves content')
const resizeCount=custom.resizeCount
result=await save([update(custom,3000,2000)],{resizeOriginal:true,scaleContent:true})
assert.equal(result.errors.length,0);assert.equal(custom.resizeCount,resizeCount,'rounded ratio is stable on repeated saves')
result=await save([update(custom,6000,4000)])
assert.equal(result.errors.length,0,'subsequent metadata-only saves accept pixel rounding')
result=await save([update(custom,3000,4000)],{resizeOriginal:true,scaleContent:true})
assert.equal(result.errors.length,0);assert.equal(custom.width,1000);assert.equal(custom.height,1333)
assert.equal(JSON.stringify(custom.children),customContent,'taller frame fits the content at its original scale')
console.log('Batch sizes passed: matching ratios preserve frames/content, integer aspect changes, proportional content fit, pixel-rounding stability, rollback, atomic validation and selected-only CMYK dispatcher.')
