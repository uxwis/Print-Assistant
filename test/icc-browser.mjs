import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {readFileSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {PDFDocument,PDFName,PDFArray,PDFRawStream,PDFNumber,decodePDFRawStream} from 'pdf-lib'
const require=createRequire(import.meta.url),{chromium}=require('C:/Users/wis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const N=PDFName.of
const input=await PDFDocument.load(readFileSync('tmp/pdfs/calculator-native.pdf')),ctx=input.context,pageInput=input.getPage(0)
const jpeg=ctx.register(ctx.stream(readFileSync('test/fixtures/photo-reference.jpg'),{Type:'XObject',Subtype:'Image',Width:16,Height:16,ColorSpace:'DeviceRGB',BitsPerComponent:8,Filter:['DCTDecode']}))
pageInput.node.Resources().lookup(N('XObject')).set(N('JPG'),jpeg)
const chained=ctx.flateStream(readFileSync('test/fixtures/photo-reference.jpg'),{Type:'XObject',Subtype:'Image',Width:16,Height:16,ColorSpace:'DeviceRGB',BitsPerComponent:8,DecodeParms:[null,null]})
chained.dict.set(N('Filter'),ctx.obj(['FlateDecode','DCTDecode']))
pageInput.node.Resources().lookup(N('XObject')).set(N('JPGChain'),ctx.register(chained))
pageInput.node.addContentStream(ctx.register(ctx.flateStream(new TextEncoder().encode('q 16 0 0 16 245 25 cm /JPG Do Q q 16 0 0 16 245 48 cm /JPGChain Do Q'))))
const invert=ctx.register(ctx.flateStream(new TextEncoder().encode('{1 exch sub}'),{FunctionType:4,Domain:[0,1],Range:[0,1]}))
pageInput.node.Resources().lookup(N('ExtGState')).lookup(N('Shadow')).lookup(N('SMask')).set(N('TR'),invert)
const nativeBytes=[...await input.save({useObjectStreams:false})]
writeFileSync('tmp/pdfs/browser-native-jpeg-mask.pdf',new Uint8Array(nativeBytes))
pageInput.node.Resources().lookup(N('ExtGState')).lookup(N('Half')).set(N('BM'),N('Multiply'))
const badBytes=[...await input.save({useObjectStreams:false})]
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
let testPage
try {
 const page=await browser.newPage({viewport:{width:360,height:640},acceptDownloads:true})
 testPage=page
 const errors=[],network=[];page.on('pageerror',e=>{errors.push(e.message);console.error('Browser error:',e.message)})
 await page.route(/^https?:/,route=>{network.push(route.request().url());return route.abort()})
 const dimensions=await build({entryPoints:['src/shared/printDimensions.ts'],bundle:true,format:'iife',globalName:'testPrintDimensions',write:false})
 await page.addInitScript(dimensions.outputFiles[0].text+'\nwindow.testPrintDimensions = testPrintDimensions;')
 await page.addInitScript(({nativeBytes,badBytes})=>{
  window.testRequests=[];window.failVector=false;window.changeDuringSave=null
  window.savedFrames=JSON.parse(localStorage.getItem('testFrames')||'null')||[
   {id:'A',name:'原稿 A',widthPx:780,heightPx:500,widthMm:275.17,heightMm:176.39,printSizeStatus:'unset'},
   {id:'B',name:'原稿 B',widthPx:500,heightPx:500,widthMm:176.39,heightMm:176.39,printSizeStatus:'valid',printSize:{widthMm:50,heightMm:50}},
   {id:'C',name:'未设置的原稿 C',widthPx:400,heightPx:800,widthMm:141.11,heightMm:282.22,printSizeStatus:'unset'}
  ]
  let selected=['A']
  const post=(type,payload)=>window.postMessage({pluginMessage:{type,payload}},'*')
  const frames=()=>window.savedFrames.filter(f=>selected.includes(f.id))
  const persist=()=>localStorage.setItem('testFrames',JSON.stringify(window.savedFrames))
  const info=()=>post('frame-info',{target:'selection',frames:frames()})
  window.selectTestFrames=ids=>{selected=ids;post('preflight-invalidated');info()}
  window.changeTestFrameWidth=width=>{const f=window.savedFrames.find(f=>f.id==='A');f.widthPx=width;f.printSizeStatus=f.printSize?'stale':'unset';post('preflight-invalidated');info()}
  window.addEventListener('message',async event=>{
   const m=event.data?.pluginMessage;if(!m||!['init','get-frame-info','set-print-sizes','create-frame','resize-frame','run-preflight','export-cmyk','softproof'].includes(m.type))return
   window.testRequests.push(m)
   if(m.type==='init')post('init-result',{hasSelection:frames().length>0})
   if(m.type==='get-frame-info')info()
   if(m.type==='set-print-sizes'){
    if(window.changeDuringSave){const f=window.savedFrames.find(f=>f.id===window.changeDuringSave);f.widthPx+=100;f.printSizeStatus='stale';window.changeDuringSave=null}
    const errors=m.payload.updates.flatMap(u=>{
     const f=window.savedFrames.find(f=>f.id===u.frameId)
     return !f || f.widthPx!==u.widthPx || f.heightPx!==u.heightPx ? [{frameId:u.frameId,message:'原稿尺寸已变化，请重新确认成品尺寸'}]
      : !Number.isFinite(u.widthMm)||!Number.isFinite(u.heightMm)||u.widthMm<=0||u.heightMm<=0 ? [{frameId:u.frameId,message:'请输入有效的宽高'}] : []
    })
    if(!errors.length){for(const u of m.payload.updates){const f=window.savedFrames.find(f=>f.id===u.frameId);if(m.payload.options?.resizeOriginal)Object.assign(f,window.testPrintDimensions.originalSizeForPrint(f.widthPx,f.heightPx,u));f.printSizeStatus='valid';f.printSize={widthMm:u.widthMm,heightMm:u.heightMm}}persist()}
    post('print-sizes-result',{requestId:m.payload.requestId,frameIds:errors.length?[]:m.payload.updates.map(u=>u.frameId),errors})
    if(!errors.length)post('preflight-invalidated');info()
   }
   if(m.type==='create-frame'){
    const {widthMm,heightMm}=m.payload,f={id:'N',name:'新建样稿',widthPx:Math.round(widthMm*72/25.4),heightPx:Math.round(heightMm*72/25.4),widthMm,heightMm,printSizeStatus:'valid',printSize:{widthMm,heightMm}}
    window.savedFrames.push(f);selected=[f.id];persist();post('frame-created',f);info()
   }
   if(m.type==='resize-frame'){
    for(const f of frames()){f.widthPx=Math.round(m.payload.widthMm*72/25.4);f.heightPx=Math.round(m.payload.heightMm*72/25.4);f.printSizeStatus='valid';f.printSize={widthMm:m.payload.widthMm,heightMm:m.payload.heightMm}}
    persist();post('frame-resized',{count:frames().length,frameIds:frames().map(f=>f.id)});post('preflight-invalidated');info()
   }
   if(m.type==='run-preflight'){
    const missing=frames().filter(f=>f.printSizeStatus==='stale')
    post('preflight-result',{requestId:m.payload.requestId,stale:false,result:{target:'selection',targetDpi:m.payload.dpi,frameCount:frames().length,nodeCount:10,issues:[],errorCount:0,warningCount:0,durationMs:5,complete:missing.length===0,skippedFrames:missing.map(f=>({id:f.id,name:f.name,reason:'尚未设置成品尺寸'}))}})
   }
   if(m.type==='export-cmyk'&&m.payload.mode==='vector'){
    post('cmyk-result',{mode:'vector',dpi:m.payload.dpi,pages:frames().map(f=>({kind:'vector',bytes:new Uint8Array(window.failVector?badBytes:nativeBytes),name:f.name,widthMm:(f.printSize?.widthMm??f.widthPx*25.4/72)+22,heightMm:(f.printSize?.heightMm??f.heightPx*25.4/72)+22,trimInsetMm:11,bleedMm:3}))});return
   }
   if(m.type==='export-cmyk'||m.type==='softproof'){
    const dpi=m.payload?.dpi||72,w=Math.round(100/25.4*dpi),h=Math.round(72/25.4*dpi)
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,w,h)
    const gradient=ctx.createLinearGradient(0,0,w,h);gradient.addColorStop(0,'#53795e');gradient.addColorStop(1,'#ad7097')
    ctx.fillStyle=gradient;ctx.fillRect(w*.11,h*.153,w*.78,h*.694)
    const blob=await new Promise(resolve=>canvas.toBlob(resolve)),bytes=new Uint8Array(await blob.arrayBuffer())
    if(m.type==='softproof')post('softproof-result',{images:[{name:'原稿 A',bytes}]})
    else post('cmyk-result',{mode:'raster',images:[{bytes,widthMm:100,heightMm:72,dpi,iccProfile:'',trimInsetMm:11,bleedMm:3}]})
   }
  })
 },{nativeBytes,badBytes})
 const button=name=>page.getByRole('button',{name,exact:true})
 const summary=()=>page.locator('.size-summary')
 const batchCount=()=>page.evaluate(()=>window.testRequests.filter(m=>m.type==='set-print-sizes').length)
 async function saveAndWait(){const count=await batchCount();await button('设置尺寸').click();await page.waitForFunction(count=>window.testRequests.filter(m=>m.type==='set-print-sizes').length>count,count);await page.locator('.size-save button').waitFor();await page.waitForFunction(()=>document.querySelector('.size-save button')?.disabled)}
 async function noOverflow(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert(await page.locator('.content').evaluate(el=>el.scrollWidth<=el.clientWidth));assert(await page.locator('.export-scroll').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth)))}
 await page.goto(pathToFileURL(resolve('dist/ui.html')).href)
 await page.getByText('设置实际印刷尺寸',{exact:true}).waitFor()
 assert.equal(await button('画板').getAttribute('aria-current'),'page')
 assert.equal(await button('已有画板').count(),0)
 assert.equal(await button('新建画板').count(),0)
 assert.equal(await button('下一步：预检').count(),0)
 await button('预检').click()
 await summary().getByText('实际印刷尺寸：275*176mm',{exact:true}).waitFor()
 assert.equal(await page.locator('[id^="print-width-"]').count(),0)
 assert(await button('开始预检').evaluate(b=>b.classList.contains('btn-primary')))
 assert(await button('生成软打样').evaluate(b=>b.classList.contains('btn-ghost')))
 const softTitle=await page.locator('.softproof-heading').boundingBox(),softButton=await button('生成软打样').boundingBox()
 assert(softButton.width<100 && softButton.y>=softTitle.y && softButton.y+softButton.height<=softTitle.y+softTitle.height)
 assert(await button('开始预检').isEnabled());await summary().getByText('检测尺寸',{exact:true}).waitFor()
 await button('开始预检').click();await page.getByText('未发现问题',{exact:true}).waitFor()
 await button('导出').click();await summary().getByText('实际印刷尺寸：275*176mm',{exact:true}).waitFor()
 assert.equal(await page.getByText('保留原稿，自动清理临时副本。',{exact:true}).count(),0)
 assert.equal(await page.locator('.export-settings #print-icc').count(),1)
 assert.equal(await page.locator('.marks-disclosure').count(),1)
 assert.equal(await page.locator('.marks-disclosure').getAttribute('open'),null)
 assert(await page.locator('#export-bleed').isHidden())
 assert(await button('导出 CMYK PDF').isEnabled())
 const referencePromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();const reference=await referencePromise;await reference.saveAs('tmp/pdfs/browser-reference.pdf')
 assert(Math.abs((await PDFDocument.load(readFileSync('tmp/pdfs/browser-reference.pdf'))).getPage(0).getTrimBox().width-780)<1e-6)
 assert.equal(await page.evaluate(()=>window.savedFrames[0].printSizeStatus),'unset')
 await button('去设置').click();await page.locator('#print-width-A').waitFor()
 assert.equal(await button('已有画板').count(),0)
 assert.equal(await button('设置尺寸').count(),1);assert.equal(await page.locator('.resize-details').count(),0)
 assert.equal(await page.getByLabel('按成品比例调整原稿',{exact:true}).count(),0)
 assert.equal(await page.getByText(/原稿 .*px/).count(),0)
 await page.locator('#print-width-A').fill('78');assert.equal(Number(await page.locator('#print-height-A').inputValue()),50)
 await button('导出').click();await button('去设置').waitFor();assert(await button('导出 CMYK PDF').isDisabled())
 await button('预检').click();await button('去设置').waitFor();assert(await button('开始预检').isEnabled())
 await button('去设置').click();assert.equal(await page.locator('#print-width-A').inputValue(),'78')
 assert.equal(await button('新建画板').count(),0);assert.equal(await page.locator('#print-width-A').inputValue(),'78')
 await saveAndWait()
 await button('预检').click();await summary().getByText('实际印刷尺寸：78 × 50 mm',{exact:true}).waitFor()
 assert.equal(await button('下一步：导出').count(),0)
 await button('开始预检').click();await page.getByText('未发现问题',{exact:true}).waitFor()
 await button('生成软打样').click();await page.locator('canvas.softproof-canvas').waitFor()
 await page.locator('.content').evaluate(el=>el.scrollTop=0);await noOverflow();await page.screenshot({path:'tmp/pdfs/preflight-ui.png',fullPage:true})

 // Multiple selected originals; invalid and stale rows reject all edits. C stays unset.
 await page.evaluate(()=>window.selectTestFrames(['A','B','C']))
 await summary().getByText('3 个画板 · 2 个已设置',{exact:true}).waitFor()
 await button('导出').click();assert(await button('导出 CMYK PDF').isEnabled());await button('去设置').click()
 assert.equal(await page.locator('#print-width-B').inputValue(),'50');assert.equal(await page.locator('#print-width-C').inputValue(),'')
 await page.locator('#print-width-A').fill('156');await page.locator('#print-width-B').fill('0')
 await page.locator('.print-size-row').filter({hasText:'原稿 B'}).getByRole('alert').waitFor()
 const invalidCount=await batchCount();await button('设置尺寸').click();assert.equal(await batchCount(),invalidCount)
 assert.equal(await page.evaluate(()=>window.savedFrames[0].printSize.widthMm),78)
 await page.locator('#print-width-B').fill('75');await page.evaluate(()=>window.changeDuringSave='B')
 await button('设置尺寸').click();await page.locator('.print-size-row').filter({hasText:'原稿 B'}).getByRole('alert').getByText(/原稿尺寸已变化/).waitFor()
 assert.equal(await page.evaluate(()=>window.savedFrames[0].printSize.widthMm),78);assert.equal(await page.evaluate(()=>window.savedFrames[1].printSize.widthMm),50)
 assert.equal(await page.locator('#print-width-A').inputValue(),'156')
 await page.locator('.print-size-row').filter({hasText:'原稿 B'}).getByRole('button',{name:'重新确认',exact:true}).click()
 assert.equal(Number(await page.locator('#print-height-B').inputValue()),63)
 await saveAndWait();assert.equal(await page.evaluate(()=>window.savedFrames[2].printSizeStatus),'unset')
 assert.equal(await page.evaluate(()=>window.testRequests.filter(m=>m.type==='set-print-sizes').at(-1).payload.updates.length),2)
 await page.waitForTimeout(3600);await page.locator('.content').evaluate(el=>el.scrollTop=0);await noOverflow()
 assert.equal(await button('设置尺寸').count(),1);await page.screenshot({path:'tmp/pdfs/frames-ui.png',fullPage:true})
 await button('预检').click();assert(await button('开始预检').isEnabled());await button('开始预检').click();await page.getByText('未发现问题',{exact:true}).waitFor()
 await page.evaluate(()=>window.selectTestFrames(['A','B']))
 await summary().getByText('2 个画板 · 2 个已设置',{exact:true}).waitFor()
 await button('导出').click();assert(await button('导出 CMYK PDF').isEnabled())
 assert.equal(await page.locator('[id^="print-width-"]').count(),0)
 assert.equal(await button('当前页面').count(),0);assert.equal(await button('选中画板').count(),0)
 const multiPromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();const multi=await multiPromise;await multi.saveAs('tmp/pdfs/browser-multi.pdf')
 assert.equal((await PDFDocument.load(readFileSync('tmp/pdfs/browser-multi.pdf'))).getPageCount(),2)

 // Drafts survive selection changes, but only currently selected dirty frames block work.
 await page.evaluate(()=>window.selectTestFrames(['A']));await button('修改').click();await page.locator('#print-width-A').fill('100')
 await page.evaluate(()=>window.selectTestFrames(['B']));await page.locator('#print-width-B').waitFor()
 await button('预检').click();await summary().getByText('实际印刷尺寸：75 × 63 mm',{exact:true}).waitFor();assert(await button('开始预检').isEnabled())
 await page.evaluate(()=>window.selectTestFrames(['A']));await button('去设置').click();assert.equal(await page.locator('#print-width-A').inputValue(),'100')
 await page.locator('#print-width-A').fill('78');await saveAndWait()
 await button('导出').click();await page.evaluate(()=>window.changeTestFrameWidth(800))
 await summary().getByText('实际印刷尺寸：需重新确认',{exact:true}).waitFor();assert(await button('导出 CMYK PDF').isDisabled())
 await button('去设置').click();await button('重新确认').click();assert.equal(Number(await page.locator('#print-height-A').inputValue()),49);await saveAndWait()
 await page.evaluate(()=>window.changeTestFrameWidth(780));await button('重新确认').click();await saveAndWait()
 await button('导出').click();await summary().getByText('实际印刷尺寸：78 × 50 mm',{exact:true}).waitFor()
 assert.equal(await page.locator('#print-icc option').count(),3);assert.equal(await button('矢量优先').getAttribute('aria-pressed'),'true')
 const hints={150:'大幅远看',300:'常规印刷',600:'精细位图'}
 for(const dpi of [150,300,600]){
  await button(String(dpi)).click();assert.equal(await page.locator('.dpi-hint').innerText(),`（${hints[dpi]}）`)
  const label=await page.locator('.dpi-label .field-label').boundingBox(),hint=await page.locator('.dpi-hint').boundingBox();assert(Math.abs(label.y-hint.y)<2)
 }
 assert.equal(await page.getByText('提高导出 DPI 不会增加原图细节；矢量文字和图形不受 DPI 限制。',{exact:true}).count(),0)
 await button('300').click();await noOverflow();await page.locator('.content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:'tmp/pdfs/export-ui.png',fullPage:true})
 await page.locator('#print-icc').evaluate(el=>el.closest('.card').scrollIntoView({block:'start'}));await page.screenshot({path:'tmp/pdfs/export-controls-ui.png',fullPage:true})
 const vectorPromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();const vector=await vectorPromise;assert(vector.suggestedFilename().includes('矢量'));await vector.saveAs('tmp/pdfs/browser-vector.pdf')
 const vectorDoc=await PDFDocument.load(readFileSync('tmp/pdfs/browser-vector.pdf'))
 assert(Math.abs(vectorDoc.getPage(0).getTrimBox().width-78*72/25.4)<1e-6)
 const images=vectorDoc.context.enumerateIndirectObjects().map(x=>x[1]).filter(x=>x instanceof PDFRawStream&&x.dict.get(N('Subtype'))===N('Image'))
 const jpegOut=images.find(x=>x.dict.lookup(N('Width'),PDFNumber).asNumber()===16&&x.dict.lookup(N('ColorSpace')) instanceof PDFArray)
 assert(jpegOut);assert(decodePDFRawStream(jpegOut).decode().some(v=>v>0))
 await page.evaluate(()=>window.failVector=true);await button('导出 CMYK PDF').click();await page.getByRole('alert').waitFor();assert((await page.getByRole('alert').innerText()).includes('混合模式'))
 await button('切换整页栅格模式').click();await button('150').click()
 const rasterPromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();const raster=await rasterPromise;assert(raster.suggestedFilename().includes('栅格'));await raster.saveAs('tmp/pdfs/browser-150.pdf')
 const rasterDoc=await PDFDocument.load(readFileSync('tmp/pdfs/browser-150.pdf'))
 const rasterImage=rasterDoc.context.enumerateIndirectObjects().map(x=>x[1]).find(x=>x instanceof PDFRawStream&&x.dict.get(N('Subtype'))===N('Image'))
 assert.equal(rasterImage.dict.lookup(N('Width'),PDFNumber).asNumber(),591)
 await page.locator('#print-icc').selectOption('custom');assert(await button('导出 CMYK PDF').isDisabled())
 await page.locator('#icc-file').setInputFiles({name:'invalid.icc',mimeType:'application/octet-stream',buffer:Buffer.alloc(200)});await page.getByRole('alert').waitFor();assert(await button('导出 CMYK PDF').isDisabled())
 await page.locator('#icc-file').setInputFiles('assets/icc/ISOcoated_v2_eci.icc');await page.getByText('已载入：ISOcoated_v2_eci.icc',{exact:true}).waitFor();await button('300').click()
 const customPromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();const custom=await customPromise;await custom.saveAs('tmp/pdfs/browser-custom-300.pdf')
 const customDoc=await PDFDocument.load(readFileSync('tmp/pdfs/browser-custom-300.pdf'))
 const intents=customDoc.catalog.lookup(N('OutputIntents'),PDFArray),icc=intents.lookup(0).lookup(N('DestOutputProfile'),PDFRawStream)
 assert.deepEqual(Buffer.from(decodePDFRawStream(icc).decode()),readFileSync('assets/icc/ISOcoated_v2_eci.icc'))
 assert(await page.evaluate(()=>window.testRequests.filter(m=>m.type==='get-frame-info').every(m=>m.payload.target==='selection')))
 assert(await page.evaluate(()=>window.testRequests.filter(m=>m.type==='export-cmyk').every(m=>!('target' in m.payload))))

 await page.evaluate(()=>window.selectTestFrames([]));await summary().getByText('请先选中原稿画板',{exact:true}).waitFor();assert(await button('导出 CMYK PDF').isDisabled())
 const selectionHint=page.locator('.export-selection-hint'),exportButton=await button('导出 CMYK PDF').boundingBox(),hintBox=await selectionHint.boundingBox()
 assert(hintBox.y>=exportButton.y+exportButton.height,'selection hint is below the export button')
 assert.equal(await page.locator('.action-bar').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px')
 assert.equal(await page.locator('.marks-disclosure').evaluate(el=>getComputedStyle(el).borderTopWidth),'0px')
 await button('预检').click();assert(await button('开始预检').isDisabled());await button('画板').click();assert.equal(await button('设置尺寸').count(),0)
 await page.setViewportSize({width:480,height:560});await noOverflow();await page.screenshot({path:'tmp/pdfs/frames-empty-ui.png',fullPage:true})
 await button('新建画板').click();await page.screenshot({path:'tmp/pdfs/frames-create-ui.png',fullPage:true});await button('← 返回').click()
 await page.setViewportSize({width:360,height:640});await noOverflow()
 // Existing new/resize capabilities stay available; newly created and resized frames save metadata.
 await button('新建画板').click();await page.locator('#frame-width').fill('90');await page.locator('#frame-height').fill('54')
 await page.locator('.card').getByRole('button',{name:'新建画板',exact:true}).click();await page.locator('#print-width-N').waitFor();assert.equal(await page.locator('#print-width-N').inputValue(),'90')
 assert.equal(await page.getByLabel('按成品比例调整原稿',{exact:true}).count(),0)
 await page.locator('#print-width-N').fill('100');assert.equal(await page.locator('#print-height-N').inputValue(),'60')
 assert.equal(await page.getByLabel('按成品比例调整原稿',{exact:true}).count(),0)
 await page.locator('#print-height-N').fill('80')
 assert.equal(await page.locator('#print-width-N').inputValue(),'100','manual height sets a custom ratio without changing the width')
 await page.locator('.resize-option-hint').getByText('（比例不一致，建议勾选）',{exact:true}).waitFor()
 await page.getByLabel('按成品比例调整原稿',{exact:true}).check();await page.getByLabel('等比缩放内容',{exact:true}).check()
 assert.equal(await page.locator('.size-resize-preview').innerText(),'设置后原稿：255 × 204 px。')
 await saveAndWait();assert.equal(await page.evaluate(()=>window.savedFrames.find(f=>f.id==='N').widthPx),255)
 assert.equal(await page.evaluate(()=>window.savedFrames.find(f=>f.id==='N').heightPx),204)
 assert(await page.evaluate(()=>window.testRequests.filter(m=>m.type==='set-print-sizes').at(-1).payload.options.scaleContent))
 assert.equal(await page.getByLabel('按成品比例调整原稿',{exact:true}).count(),0,'adjustment is hidden once the saved artwork matches')
 // Exact large-format regression: mm settings do not enlarge matching artwork.
 await page.evaluate(()=>{window.savedFrames.push({id:'L',name:'大幅原稿',widthPx:3000,heightPx:2500,printSizeStatus:'unset'});window.selectTestFrames(['L'])})
 await page.locator('#print-width-L').fill('3000');await page.locator('#print-height-L').fill('2500')
 assert.equal(await page.getByLabel('按成品比例调整原稿',{exact:true}).count(),0)
 await page.locator('#size-preset').selectOption('A4 210×297')
 assert(await page.getByLabel('按成品比例调整原稿',{exact:true}).isVisible())
 assert(await page.getByLabel('按成品比例调整原稿',{exact:true}).isChecked()===false)
 await page.getByLabel('按成品比例调整原稿',{exact:true}).check()
 await page.locator('#print-width-L').fill('3000');await page.locator('#print-height-L').fill('2500')
 assert.equal(await page.getByLabel('按成品比例调整原稿',{exact:true}).count(),0,'returning to a matching ratio hides and clears adjustment')
 assert.equal(await page.getByLabel('等比缩放内容',{exact:true}).count(),0)
 await noOverflow();await page.setViewportSize({width:480,height:560});await page.waitForTimeout(3600)
 await page.screenshot({path:'tmp/pdfs/frames-ratio-ui.png',fullPage:true})
 await saveAndWait();assert.equal(await page.evaluate(()=>window.savedFrames.find(f=>f.id==='L').widthPx),3000)
 assert.equal(await page.evaluate(()=>window.savedFrames.find(f=>f.id==='L').heightPx),2500)
 assert.equal(await page.evaluate(()=>window.testRequests.filter(m=>m.type==='set-print-sizes').at(-1).payload.options.resizeOriginal),false,'hidden adjustment cannot resize artwork')
 await button('导出').click();await summary().getByText('实际印刷尺寸：3000 × 2500 mm',{exact:true}).waitFor()
 await page.evaluate(()=>window.failVector=false)
 await button('矢量优先').click()
 const largePromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();const large=await largePromise;await large.saveAs('tmp/pdfs/browser-large-ratio.pdf')
 const largeDoc=await PDFDocument.load(readFileSync('tmp/pdfs/browser-large-ratio.pdf'))
 assert(Math.abs(largeDoc.getPage(0).getTrimBox().width-3000*72/25.4)<1e-6)
 assert(Math.abs(largeDoc.getPage(0).getTrimBox().height-2500*72/25.4)<1e-6)
 await button('画板').click();await page.setViewportSize({width:360,height:640})
 await page.evaluate(()=>window.selectTestFrames(['N']))
 await page.evaluate(()=>{const f=window.savedFrames.find(f=>f.id==='N');f.widthPx=595;f.heightPx=842;delete f.printSize;f.printSizeStatus='unset';window.selectTestFrames(['N'])})
 await page.waitForFunction(()=>document.querySelector('#print-width-N')?.value==='210')
 assert.equal(await page.locator('#size-preset').inputValue(),'A4 210×297')
 assert.equal(await page.locator('#print-height-N').inputValue(),'297')
 assert.equal(await page.evaluate(()=>window.savedFrames.find(f=>f.id==='N').printSizeStatus),'unset','autofill requires explicit save')
 await page.screenshot({path:'tmp/pdfs/frames-auto-preset-ui.png',fullPage:true});await saveAndWait()
 await page.locator('#size-preset').selectOption('');assert.equal(await page.locator('#print-width-N').inputValue(),'')
 await page.locator('#size-preset').selectOption('A4 210×297');assert.equal(await page.locator('#print-height-N').inputValue(),'297');await saveAndWait()
 await page.evaluate(()=>window.selectTestFrames(['A']));await page.reload();await page.locator('#print-width-A').waitFor()
 assert.equal(await page.locator('#print-width-A').inputValue(),'78');assert(await button('已设置').isDisabled());await noOverflow()
 // The wider default window fits the primary workflow; optional marks remain
 // discoverable and their changes reach export even after collapsing/reopening.
 await page.setViewportSize({width:480,height:560});await button('导出').click();await noOverflow()
 assert(await page.locator('.export-scroll').evaluate(el=>el.scrollHeight<=el.clientHeight))
 const action=await button('导出 CMYK PDF').boundingBox();assert(action.y>=0 && action.y+action.height<=560)
 await page.locator('.marks-disclosure > summary').click()
 await page.waitForFunction(()=>{
  const body=document.querySelector('.marks-body').getBoundingClientRect()
  const scroll=document.querySelector('.export-scroll').getBoundingClientRect()
  return body.top>=scroll.top && body.bottom<=scroll.bottom+1
 })
 await page.getByLabel('出血 (mm)',{exact:true}).fill('5')
 await page.getByLabel('安全边距 (mm)',{exact:true}).fill('4')
 await page.getByRole('checkbox',{name:'裁切线',exact:true}).uncheck()
 await page.getByRole('checkbox',{name:'出血框（红色）',exact:true}).uncheck()
 await noOverflow()
 await page.locator('.export-scroll').evaluate(el=>el.scrollTop=el.scrollHeight)
 const stickyAction=await button('导出 CMYK PDF').boundingBox();assert.equal(stickyAction.y,action.y)
 await page.locator('.marks-disclosure > summary').click();assert.equal(await page.locator('.marks-summary').innerText(),'5 mm')
 await button('预检').click();await button('导出').click();assert.equal(await page.locator('.marks-summary').innerText(),'5 mm')
 assert.equal(await page.locator('.marks-disclosure').getAttribute('open'),null)
 const marksPromise=page.waitForEvent('download');await button('导出 CMYK PDF').click();await marksPromise
 const markSettings=await page.evaluate(()=>window.testRequests.filter(m=>m.type==='export-cmyk').at(-1).payload.config)
 assert.equal(markSettings.bleed,5);assert.equal(markSettings.safetyMargin,4)
 assert.equal(markSettings.showCropMarks,false);assert.equal(markSettings.showBleedBox,false)
 await page.locator('#print-icc').selectOption('custom');await button('导出 CMYK PDF').waitFor();assert(await button('导出 CMYK PDF').isDisabled())
 assert(await page.getByText('请先导入印厂或设备的 CMYK ICC 文件。',{exact:true}).isVisible())
 await page.getByRole('button',{name:'150',exact:true}).click()
 await page.locator('.marks-disclosure > summary').click();assert.equal(await page.getByLabel('出血 (mm)',{exact:true}).inputValue(),'5')
 await noOverflow()
 assert.deepEqual(errors,[]);assert.deepEqual(network,[])
 console.log('Browser integration passed: conditional ratio adjustment, independent custom dimensions, preset mismatches, automatic hide/reset, integer preview, unchanged large-format artwork, 3000x2500mm PDF, selection hint below export, removed dividers, batch save, 360px layout and ICC/vector/raster regression.')
}catch(error){
 await testPage?.screenshot({path:'tmp/pdfs/browser-failure.png',fullPage:true})
 console.error(await testPage?.evaluate(()=>({body:document.body.innerText,requests:window.testRequests.slice(-5)})))
 throw error
}finally{await browser.close()}
