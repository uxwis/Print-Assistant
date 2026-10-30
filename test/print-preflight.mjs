import {build} from 'esbuild'
import {pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
await build({entryPoints:['src/plugin/preflight.ts','src/plugin/printSize.ts','src/plugin/utils.ts','src/shared/geometry.ts','src/shared/constants.ts'],outdir:'tmp/preflight-test',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm'})
const load=p=>import(pathToFileURL(resolve(`tmp/preflight-test/${p}.mjs`)))
const {runPreflight}=await load('plugin/preflight'),{savePrintSize,readPrintSize,requirePrintSize}=await load('plugin/printSize')
const {imagePixelMatrix,maxScale,multiply}=await load('shared/geometry'),{DEFAULT_THRESHOLDS}=await load('shared/constants')
const {relativeMatrix,relativeBounds}=await load('plugin/utils')
const near=(a,b)=>assert(Math.abs(a-b)<1e-6,`${a} != ${b}`)
// Affine transforms must cancel correctly even away from the page origin.
for(const transform of [[[1,0,1200],[0,1,700]],[[0,-1,2000],[1,0,3000]],[[2,0.4,900],[0.3,1.5,-600]]]) {
 const ancestor={absoluteTransform:transform},same={absoluteTransform:transform,width:25,height:10}
 const relative=relativeMatrix(same,ancestor)
 for(let row=0;row<3;row++)for(let col=0;col<3;col++)near(relative[row][col],row===col?1:0)
 const bounds=relativeBounds(same,ancestor);near(bounds.x,0);near(bounds.y,0);near(bounds.width,25);near(bounds.height,10)
}
near(72/maxScale(multiply([72/25.4,0,0,72/25.4],imagePixelMatrix({scaleMode:'FILL'},50,50,1000,1000))),508)
near(maxScale(imagePixelMatrix({scaleMode:'FILL'},100,100,200,100)),1)
near(maxScale(imagePixelMatrix({scaleMode:'FIT'},100,100,200,100)),0.5)
near(maxScale(imagePixelMatrix({scaleMode:'CROP',imageTransform:[[0.5,0,0.25],[0,0.5,0.25]]},100,100,1000,1000)),0.2)
near(maxScale(imagePixelMatrix({scaleMode:'CROP',imageTransform:[[0,-0.5,1],[0.5,0,0]]},100,100,1000,1000)),0.2)
near(maxScale(imagePixelMatrix({scaleMode:'TILE',scalingFactor:2,rotation:90},100,100,1000,1000)),2)
near(maxScale(imagePixelMatrix({scaleMode:'FILL',rotation:90},100,100,200,100)),1)
assert.equal(imagePixelMatrix({scaleMode:'CROP',imageTransform:[[0,0,0],[0,0,0]]},100,100,1000,1000),undefined)

let seq=0
const page={type:'PAGE',children:[],selection:[]},font={family:'Test',style:'Regular'}
function node(type,props={}) {
 const data={}
 return {id:String(++seq),name:type,type,parent:page,visible:true,opacity:1,width:1000,height:1000,
  absoluteTransform:[[1,0,0],[0,1,0]],fills:[],strokes:[],effects:[],getPluginData:k=>data[k]||'',setPluginData:(k,v)=>data[k]=v,...props}
}
function add(parent,n){n.parent=parent;parent.children.push(n);return n}
const frame=node('FRAME',{name:'已有画板',children:[]}),other=node('FRAME',{name:'第二画板',children:[]})
page.children=[frame,other];page.selection=[frame]
const image=node('RECTANGLE',{name:'照片',width:500,height:500,fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'FILL'}]})
add(frame,image)
const text=node('TEXT',{name:'小字',width:20,height:10,fontName:font,fontSize:12,characters:'test',fills:[{type:'SOLID',color:{r:0.2,g:0.1,b:0.15}}]})
add(frame,text)
add(frame,node('RECTANGLE',{name:'细线',width:100,height:10,strokeWeight:0.5,strokes:[{type:'SOLID'}]}))
const hidden=node('FRAME',{visible:false,children:[]});add(frame,hidden)
add(hidden,node('RECTANGLE',{name:'隐藏图片',fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'FILL'}]}))
globalThis.figma={currentPage:page,mixed:Symbol(),listAvailableFontsAsync:async()=>[{fontName:font}],loadFontAsync:async()=>{},getImageByHash:()=>({getSizeAsync:async()=>({width:1000,height:1000})})}
const run=dpi=>runPreflight({target:'selection',thresholds:{...DEFAULT_THRESHOLDS,targetDpi:dpi},safetyMargin:3})
let result=await run(300)
assert.equal(result.complete,true);assert.equal(result.skippedFrames.length,0)
assert.match(result.issues.find(i=>i.type==='low-dpi').message,/144 DPI/,'unset artwork is checked at the detected 72-DPI physical scale')
assert(!result.issues.some(i=>['tiny-text','thin-line'].includes(i.type)))
assert(result.issues.some(i=>i.type==='safe-area'))
assert(!result.issues.some(i=>i.type==='four-color-black'),'12pt detected text exceeds the small-text threshold')
assert.equal(readPrintSize(frame).status,'unset','preflight does not persist the detected size')
text.fontSize=4
frame.children.find(n=>n.name==='细线').strokeWeight=0.1
result=await run(300)
assert(result.issues.some(i=>i.type==='tiny-text'));assert(result.issues.some(i=>i.type==='thin-line'))
text.fontSize=12
frame.children.find(n=>n.name==='细线').strokeWeight=0.5
savePrintSize(frame,{widthMm:100,heightMm:100})
assert.equal(readPrintSize(frame).status,'valid');assert.equal(requirePrintSize(frame).widthMm,100)
result=await run(300);assert.equal(result.complete,true);assert(!result.issues.some(i=>i.type==='low-dpi'))
assert(result.issues.some(i=>i.type==='tiny-text'));assert(result.issues.some(i=>i.type==='thin-line'));assert(result.issues.some(i=>i.type==='safe-area'))
assert.equal(result.issues.find(i=>i.type==='four-color-black').severity,'error')
result=await run(600);assert(!result.issues.some(i=>i.type==='low-dpi'),'high export DPI does not raise the practical image minimum')
savePrintSize(frame,{widthMm:400,heightMm:400})
result=await run(300);assert.equal(result.issues.find(i=>i.type==='low-dpi').severity,'warning')
assert.match(result.issues.find(i=>i.type==='low-dpi').message,/建议 ≥ 200 DPI/)
result=await run(150);assert.equal(result.issues.find(i=>i.type==='low-dpi').severity,'warning')
savePrintSize(frame,{widthMm:600,heightMm:600})
result=await run(300);assert.equal(result.issues.find(i=>i.type==='low-dpi').severity,'error')
savePrintSize(frame,{widthMm:400,heightMm:400})
assert(!result.issues.some(i=>i.nodeName==='隐藏图片'))
frame.fills=[{type:'IMAGE',imageHash:'photo',scaleMode:'FILL'}]
result=await run(300);assert(result.issues.some(i=>i.type==='low-dpi'&&i.nodeId===frame.id))
// The text box spans the page, but its centered glyphs are safely inside it.
text.width=1000;text.height=1000;text.absoluteRenderBounds={x:450,y:450,width:100,height:30}
result=await run(300);assert(!result.issues.some(i=>i.type==='safe-area'&&i.nodeId===text.id))
// Page coordinates must be transformed back into a translated, rotated frame.
frame.absoluteTransform=[[0,-1,2000],[1,0,3000]]
text.absoluteRenderBounds={x:1520,y:3450,width:30,height:100}
result=await run(300);assert(!result.issues.some(i=>i.type==='safe-area'&&i.nodeId===text.id))
frame.absoluteTransform=[[1,0,0],[0,1,0]]
text.absoluteRenderBounds={x:2,y:450,width:100,height:30}
result=await run(300);assert.match(result.issues.find(i=>i.type==='safe-area'&&i.nodeId===text.id).message,/0.8mm/)
text.absoluteRenderBounds=null
result=await run(300);assert(!result.issues.some(i=>i.type==='safe-area'&&i.nodeId===text.id))
text.absoluteRenderBounds={x:0,y:0,width:0,height:0}
result=await run(300);assert(!result.issues.some(i=>i.type==='safe-area'&&i.nodeId===text.id))
frame.width=1100;assert.equal(readPrintSize(frame).status,'stale');assert.throws(()=>requirePrintSize(frame),/重新确认/)
result=await run(300);assert.equal(result.complete,false);assert(!result.issues.some(i=>i.type==='low-dpi'))
assert.throws(()=>savePrintSize(frame,{widthMm:100,heightMm:100}),/比例/)
assert.throws(()=>savePrintSize(frame,{widthMm:NaN,heightMm:1}),/有效/)
savePrintSize(other,{widthMm:200,heightMm:200});page.selection=[other]
assert.equal((await run(300)).complete,true)
page.selection=[];await assert.rejects(()=>run(300),/选中/)
console.log('Print geometry and preflight passed: 508 DPI, fill/fit/crop/tile/rotation, real text/strokes/safety, root images, hidden nodes, thresholds, per-frame persistence and stale dimensions.')
