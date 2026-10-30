import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFString, PDFBool, type PDFObject, type PDFRef, decodePDFRawStream } from 'pdf-lib'
import type { VectorPagePayload } from '../../shared/types'
import { createIccConverter, type PrintProfile } from '../color/icc'
import { parseInstructions, emitInstruction, instructionNumbers } from './contentStream'
import { number, numbers, pdfFunction } from './pdfFunctions'
import { decodeImageSamples, downsample } from './pdfImages'
import { IDENTITY, multiply, maxScale, type Linear } from '../../shared/geometry'

type Converter = Awaited<ReturnType<typeof createIccConverter>>
interface ColorSpec { key:object|string; channels:number; space?:PDFObject; convert:(values:number[])=>number[]; samples:(bytes:Uint8Array)=>Uint8Array }
interface Scope { source:PDFDict; out:PDFDict; mask:boolean }
interface ColorState { fill:ColorSpec; stroke:ColorSpec }
interface ImageWork { stream:PDFRawStream; spec:ColorSpec; mask:boolean; maxPixelScale:number; name:string; ref?:PDFRef }
const name=(s:string)=>PDFName.of(s)
const fmt=(n:number)=>Number(n.toFixed(6)).toString()
const tokenName=(raw:string)=>raw.slice(1).replace(/#([0-9a-f]{2})/ig,(_,hex)=>String.fromCharCode(parseInt(hex,16)))
function literal(dict:PDFDict,omit:string[]=[]):Record<string,PDFObject> {
  const values:Record<string,PDFObject>={}
  for(const [key,value] of dict.entries()) if(!omit.includes(key.decodeText())) values[key.decodeText()]=value
  return values
}
function contents(obj:PDFObject|undefined):string {
  if(obj instanceof PDFArray) {const parts=[];for(let i=0;i<obj.size();i++) parts.push(contents(obj.lookup(i)));return parts.join('\n')}
  if(obj instanceof PDFRawStream) {
    const bytes=decodePDFRawStream(obj).decode();let text=''
    for(let at=0;at<bytes.length;at+=16384)text+=String.fromCharCode(...bytes.subarray(at,at+16384))
    return text
  }
  if(!obj) return ''
  throw new Error('PDF 内容流无效')
}
const contentBytes=(text:string)=>Uint8Array.from(text,c=>c.charCodeAt(0))

class VectorConversion {
  private profileSpecs=new Map<PDFRawStream,Promise<ColorSpec>>()
  private converters:Converter[]=[]
  private images=new Map<PDFRawStream,ImageWork[]>()
  private sequence=0
  readonly warnings=new Set<string>()
  private rgb!:ColorSpec
  private gray!:ColorSpec
  private cmyk!:ColorSpec
  readonly iccRef:PDFRef
  readonly colorSpace:PDFArray
  constructor(readonly doc:PDFDocument,readonly profile:PrintProfile,readonly dpi:number) {
    this.iccRef=doc.context.register(doc.context.flateStream(profile.bytes,{N:4,Alternate:'DeviceCMYK'}))
    this.colorSpace=doc.context.obj(['ICCBased',this.iccRef]) as PDFArray
  }
  async init() {
    const converter=await createIccConverter(this.profile);this.converters.push(converter)
    this.rgb={...this.spec('srgb',3,converter),space:name('DeviceRGB')}
    this.gray={key:'gray',channels:1,space:name('DeviceGray'),convert:v=>this.rgb.convert([v[0],v[0],v[0]]),samples:b=>{
      const rgb=new Uint8Array(b.length*3);for(let i=0;i<b.length;i++) rgb.fill(b[i],i*3,i*3+3);return converter.toCmyk(rgb)
    }}
    this.cmyk={key:'target-cmyk',channels:4,space:name('DeviceCMYK'),convert:v=>v,samples:b=>b}
  }
  dispose(){for(const converter of this.converters) converter.dispose()}
  private spec(key:object|string,channels:number,converter:Converter):ColorSpec {
    const cache=new Map<string,number[]>()
    return {key,channels,samples:b=>converter.toCmyk(b),convert:values=>{
      if(values.length!==channels || values.some(v=>!Number.isFinite(v))) throw new Error('PDF 色值通道不匹配')
      const bytes=Uint8Array.from(values,v=>Math.round(Math.max(0,Math.min(1,v))*255)),cacheKey=bytes.join(',')
      let result=cache.get(cacheKey)
      if(!result) {result=Array.from(converter.toCmyk(bytes),v=>v/255);if(cache.size<65536)cache.set(cacheKey,result)}
      return result
    }}
  }
  private resource(scope:Scope,category:string,key:string):PDFObject|undefined {
    const dict=scope.source.lookup(name(category))
    return dict instanceof PDFDict ? dict.lookup(name(key)) : undefined
  }
  private add(scope:Scope,category:string,key:string,value:PDFObject):void {
    let dict=scope.out.lookup(name(category))
    if(!(dict instanceof PDFDict)){dict=this.doc.context.obj({});scope.out.set(name(category),dict)}
    ;(dict as PDFDict).set(name(key),value)
  }
  private scope(parent:PDFDict|undefined,local:PDFDict|undefined,mask=false):Scope {
    const merged=this.doc.context.obj({}) as PDFDict
    for(const source of [parent,local]) if(source) for(const [key,value] of source.entries()) {
      const incoming=this.doc.context.lookup(value), previous=merged.lookup(key)
      if(incoming instanceof PDFDict) {
        const combined=this.doc.context.obj(previous instanceof PDFDict ? literal(previous) : {}) as PDFDict
        for(const [k,v] of incoming.entries()) combined.set(k,v)
        merged.set(key,combined)
      } else merged.set(key,value)
    }
    const result={source:merged,out:this.doc.context.obj({}) as PDFDict,mask}
    if(!mask)this.add(result,'ColorSpace','PrintCMYK',this.colorSpace)
    else {
      // Luminosity is computed in the source blending space, not the print ICC.
      for(const key of ['DefaultGray','DefaultRGB','DefaultCMYK']) {
        const value=this.resource(result,'ColorSpace',key)
        if(value)this.add(result,'ColorSpace',key,value)
      }
    }
    return result
  }
  private async color(obj:PDFObject|undefined,scope:Scope,allowDefault=true):Promise<ColorSpec> {
    if(obj instanceof PDFName) {
      const key=obj.decodeText()
      const builtin=key==='DeviceRGB'||key==='RGB' ? this.rgb : key==='DeviceGray'||key==='G' ? this.gray : key==='DeviceCMYK'||key==='CMYK' ? this.cmyk : undefined
      if(builtin) {
        const override=allowDefault && this.resource(scope,'ColorSpace',builtin===this.rgb?'DefaultRGB':builtin===this.gray?'DefaultGray':'DefaultCMYK')
        return override ? this.color(override,scope,false) : builtin
      }
      const resource=this.resource(scope,'ColorSpace',key)
      if(resource && resource!==obj)return this.color(resource,scope,false)
      throw new Error(`暂不支持 PDF 颜色空间 ${key}`)
    }
    if(obj instanceof PDFArray && obj.lookup(0)===name('ICCBased')) {
      const stream=obj.lookup(1)
      if(!(stream instanceof PDFRawStream))throw new Error('PDF ICC 数据无效')
      let pending=this.profileSpecs.get(stream)
      if(!pending) {
        pending=(async()=>{
          const n=number(stream.dict,'N')
          if(n!==1&&n!==3&&n!==4)throw new Error('暂不支持此 ICC 通道数')
          const bytes=decodePDFRawStream(stream).decode()
          if(bytes.length<132 || bytes.length>32*1024*1024)throw new Error('PDF 源 ICC 数据无效')
          const converter=await createIccConverter(this.profile,{bytes,channels:n});this.converters.push(converter)
          return {...this.spec(stream,n,converter),space:obj}
        })()
        this.profileSpecs.set(stream,pending)
      }
      return pending
    }
    throw new Error('暂不支持 PDF 中的校准色、索引色、图案或专色结构')
  }
  private async imageWork(stream:PDFRawStream,scope:Scope,ctm:Linear,label:string):Promise<ImageWork> {
    const stencil=stream.dict.lookup(name('ImageMask'))===PDFBool.True
    const spec=stencil?this.gray:await this.color(stream.dict.lookup(name('ColorSpace')),scope)
    const mask=scope.mask||stencil
    const list=this.images.get(stream)??[]
    let work=list.find(w=>w.mask===mask)
    if(work && work.spec.key!==spec.key)throw new Error('共享图片的颜色资源不一致')
    if(!work){work={stream,spec,mask,maxPixelScale:0,name:label};list.push(work);this.images.set(stream,list)}
    const w=number(stream.dict,'Width'),h=number(stream.dict,'Height')
    work.maxPixelScale=Math.max(work.maxPixelScale,maxScale(multiply(ctm,[1/w,0,0,1/h])))
    return work
  }
  private checkBlend(dict:PDFDict) {
    const blend=dict.lookup(name('BM'))
    const modes=blend instanceof PDFArray ? Array.from({length:blend.size()},(_,i)=>blend.lookup(i)) : blend ? [blend] : []
    if(modes.some(mode=>mode!==name('Normal')&&mode!==name('Compatible')))throw new Error('暂不支持此 PDF 混合模式')
    for(const key of ['TR','TR2']) {
      const transfer=dict.lookup(name(key))
      if(transfer && transfer!==name('Identity') && transfer!==name('Default'))throw new Error('暂不支持 PDF 色调传递函数')
    }
    if(dict.lookup(name('OP'))===PDFBool.True||dict.lookup(name('op'))===PDFBool.True)throw new Error('暂不支持 PDF 叠印设置')
  }
  private maskForm(dict:PDFDict):{stream:PDFRawStream;luminosity:boolean}|undefined {
    const mask=dict.lookup(name('SMask'))
    if(!mask||mask===name('None'))return
    if(!(mask instanceof PDFDict))throw new Error('PDF 透明蒙版结构无效')
    const kind=mask.lookup(name('S')),stream=mask.lookup(name('G'))
    if(!(stream instanceof PDFRawStream)||(kind!==name('Alpha')&&kind!==name('Luminosity')))throw new Error('暂不支持此 PDF 透明蒙版')
    const transfer=mask.lookup(name('TR'))
    // A soft-mask transfer maps opacity, not colour. Preserve the original function,
    // including Skia's Type 4 inversion, for the PDF renderer to evaluate.
    if(transfer && transfer!==name('Identity')) {
      const fn=transfer instanceof PDFRawStream ? transfer.dict : transfer
      if(!(fn instanceof PDFDict) || ![0,2,3,4].includes(number(fn,'FunctionType'))) throw new Error('PDF 蒙版传递函数无效')
    }
    return {stream,luminosity:kind===name('Luminosity')}
  }
  private formMatrix(stream:PDFRawStream):Linear {
    const matrix=stream.dict.lookup(name('Matrix'))
    if(!matrix)return IDENTITY
    const values=numbers(matrix)
    if(values.length!==6)throw new Error('PDF Form 变换无效')
    return values.slice(0,4) as Linear
  }
  async collect(content:string,scope:Scope,initial:Linear,label:string,path=new Set<PDFRawStream>()):Promise<void> {
    let ctm=initial
    const stack:Linear[]=[]
    const enter=async(stream:PDFRawStream,mask:boolean)=>{
      if(path.has(stream)||path.size>64)throw new Error('PDF Form 循环引用或嵌套过深')
      const resources=stream.dict.lookup(name('Resources'))
      const child=this.scope(scope.source,resources instanceof PDFDict?resources:undefined,mask)
      const next=new Set(path);next.add(stream)
      await this.collect(contents(stream),child,multiply(ctm,this.formMatrix(stream)),label,next)
    }
    for(const ins of parseInstructions(content)) {
      if(ins.op==='q')stack.push([...ctm] as Linear)
      else if(ins.op==='Q'){const restored=stack.pop();if(!restored)throw new Error('PDF 图形状态不平衡');ctm=restored}
      else if(ins.op==='cm'){const v=instructionNumbers(ins);if(v.length!==6)throw new Error('PDF 变换无效');ctm=multiply(ctm,v.slice(0,4) as Linear)}
      else if(ins.op==='Do') {
        const obj=this.resource(scope,'XObject',tokenName(ins.operands[0]?.raw??''))
        if(!(obj instanceof PDFRawStream))throw new Error('PDF XObject 无效')
        if(obj.dict.lookup(name('Subtype'))===name('Image'))await this.imageWork(obj,scope,ctm,label)
        else if(obj.dict.lookup(name('Subtype'))===name('Form'))await enter(obj,scope.mask)
        else throw new Error('暂不支持此 PDF XObject')
      } else if(ins.op==='gs') {
        const state=this.resource(scope,'ExtGState',tokenName(ins.operands[0]?.raw??''))
        if(!(state instanceof PDFDict))throw new Error('PDF 透明度资源无效')
        this.checkBlend(state)
        const mask=this.maskForm(state)
        if(mask)await enter(mask.stream,scope.mask||mask.luminosity)
      }
    }
    if(stack.length)throw new Error('PDF 图形状态不平衡')
  }
  private async convertImage(work:ImageWork):Promise<PDFRef> {
    if(work.ref)return work.ref
    const {stream,spec}=work,dict=stream.dict,w=number(dict,'Width'),h=number(dict,'Height')
    if(number(dict,'SMaskInData',0)!==0)throw new Error('暂不支持图片内嵌透明通道')
    let samples=await decodeImageSamples(stream,spec.channels)
    const ratio=Math.min(1,this.dpi*work.maxPixelScale/72)
    const newW=Math.max(1,Math.min(w,Math.ceil(w*ratio))),newH=Math.max(1,Math.min(h,Math.ceil(h*ratio)))
    if(work.maxPixelScale>0 && 72/work.maxPixelScale<this.dpi-0.5)this.warnings.add(`“${work.name}”中的图片／效果位图有效约 ${Math.round(72/work.maxPixelScale)} DPI，低于目标 ${this.dpi} DPI；已保留原像素，未强行放大。`)
    const soft=dict.lookup(name('SMask')),hard=dict.lookup(name('Mask'))
    if(soft&&hard)throw new Error('暂不支持同时包含两种蒙版的图片')
    let alpha:Uint8Array|undefined
    const maskStream=soft??(hard instanceof PDFRawStream?hard:undefined)
    if(maskStream) {
      if(!(maskStream instanceof PDFRawStream)||number(maskStream.dict,'Width')!==w||number(maskStream.dict,'Height')!==h)throw new Error('暂不支持不同像素尺寸的图片蒙版')
      const maskSpace=maskStream.dict.lookup(name('ColorSpace'))
      if(soft && maskSpace!==name('DeviceGray'))throw new Error('暂不支持此图片透明蒙版颜色空间')
      alpha=await decodeImageSamples(maskStream,1)
      if(hard)alpha=Uint8Array.from(alpha,v=>255-v)
      const matteObj=maskStream.dict.lookup(name('Matte'))
      if(matteObj) {
        const matte=numbers(matteObj)
        if(matte.length!==spec.channels)throw new Error('PDF 蒙版 Matte 通道无效')
        for(let i=0;i<w*h;i++)for(let c=0;c<spec.channels;c++)samples[i*spec.channels+c]=alpha[i] ? Math.round(Math.max(0,Math.min(255,(samples[i*spec.channels+c]-(1-alpha[i]/255)*matte[c]*255)/(alpha[i]/255)))) : 0
      }
    } else if(hard instanceof PDFArray) {
      if(dict.lookup(name('Decode')))throw new Error('暂不支持带自定义 Decode 的色键蒙版')
      const bounds=numbers(hard)
      if(bounds.length!==spec.channels*2)throw new Error('PDF 色键蒙版通道无效')
      alpha=new Uint8Array(w*h)
      for(let i=0;i<alpha.length;i++)alpha[i]=Array.from({length:spec.channels},(_,c)=>samples[i*spec.channels+c]).every((v,c)=>v>=bounds[c*2]&&v<=bounds[c*2+1])?0:255
    } else if(hard)throw new Error('暂不支持此图片蒙版')
    if(alpha && (newW!==w||newH!==h)) {
      const premult=Uint8Array.from(samples,(v,i)=>Math.round(v*alpha![Math.floor(i/spec.channels)]/255))
      samples=downsample(premult,w,h,newW,newH,spec.channels)
      alpha=downsample(alpha,w,h,newW,newH,1)
      for(let i=0;i<samples.length;i++){const a=alpha[Math.floor(i/spec.channels)];samples[i]=a ? Math.min(255,Math.round(samples[i]*255/a)) : 0}
    } else samples=downsample(samples,w,h,newW,newH,spec.channels)
    const values:Record<string,any>={...literal(dict,['Length','Filter','DecodeParms','Decode','Mask','SMask','Matte','ColorSpace','BitsPerComponent']),Width:newW,Height:newH,BitsPerComponent:8}
    if(dict.lookup(name('ImageMask'))===PDFBool.True) {
      const stride=Math.ceil(newW/8),packed=new Uint8Array(stride*newH)
      for(let y=0;y<newH;y++)for(let x=0;x<newW;x++)if(samples[y*newW+x]>=128)packed[y*stride+(x>>3)]|=1<<(7-(x&7))
      values.BitsPerComponent=1
      work.ref=this.doc.context.register(this.doc.context.flateStream(packed,values));return work.ref
    }
    values.ColorSpace=work.mask ? spec.space ?? name('DeviceGray') : this.colorSpace
    if(alpha)values.SMask=this.doc.context.register(this.doc.context.flateStream(alpha,{Type:'XObject',Subtype:'Image',Width:newW,Height:newH,ColorSpace:'DeviceGray',BitsPerComponent:8}))
    work.ref=this.doc.context.register(this.doc.context.flateStream(work.mask ? samples : spec.samples(samples),values))
    return work.ref
  }
  private async shading(obj:PDFObject|undefined,scope:Scope):Promise<PDFObject> {
    const dict=obj instanceof PDFRawStream ? obj.dict : obj
    if(!(dict instanceof PDFDict))throw new Error('PDF 渐变资源无效')
    const type=number(dict,'ShadingType')
    if(type!==2&&type!==3)throw new Error(`暂不支持 PDF 网格／复杂渐变（类型 ${type}）`)
    const spec=await this.color(dict.lookup(name('ColorSpace')),scope)
    if(scope.mask) {
      return this.doc.context.obj({...literal(dict),ColorSpace:spec.space??name('DeviceGray')})
    }
    const source=pdfFunction(dict.lookup(name('Function'))),count=1024,rgb:number[]=[]
    for(let i=0;i<count;i++) {
      const values=source.evaluate(source.domain[0]+i/(count-1)*(source.domain[1]-source.domain[0]))
      if(values.length!==spec.channels)throw new Error('PDF 渐变色值通道无效')
      rgb.push(...values)
    }
    const samples=spec.samples(Uint8Array.from(rgb,v=>Math.round(Math.max(0,Math.min(1,v))*255)))
    const fn=this.doc.context.register(this.doc.context.flateStream(samples,{FunctionType:0,Domain:source.domain,Range:[0,1,0,1,0,1,0,1],Size:[count],BitsPerSample:8,Order:1}))
    const converted=this.doc.context.obj({...literal(dict),ColorSpace:this.colorSpace,Function:fn}) as PDFDict
    const background=dict.lookup(name('Background'))
    if(background)converted.set(name('Background'),this.doc.context.obj(spec.convert(numbers(background))))
    return converted
  }
  private async form(stream:PDFRawStream,parent:Scope,state:ColorState,mask=parent.mask,depth=0):Promise<PDFRef> {
    if(depth>64)throw new Error('PDF Form 嵌套过深')
    const resources=stream.dict.lookup(name('Resources')),scope=this.scope(parent.source,resources instanceof PDFDict?resources:undefined,mask)
    const group=stream.dict.lookup(name('Group'))
    let newGroup:PDFDict|undefined
    if(group instanceof PDFDict) {
      newGroup=this.doc.context.obj(literal(group)) as PDFDict
      const groupSpace=group.lookup(name('CS'))
      if(mask) {
        if(groupSpace)newGroup.set(name('CS'),(await this.color(groupSpace,scope)).space??name('DeviceGray'))
      } else newGroup.set(name('CS'),this.colorSpace)
    }
    const initial=mask ? {fill:this.gray,stroke:this.gray} : state
    const converted=await this.convertContent(contents(stream),scope,initial,depth+1)
    return this.doc.context.register(this.doc.context.flateStream(contentBytes(converted),{
      ...literal(stream.dict,['Length','Filter','DecodeParms']),Resources:scope.out,...(newGroup?{Group:newGroup}:{})
    }))
  }
  private async graphicsState(dict:PDFDict,scope:Scope,state:ColorState,depth:number):Promise<PDFDict> {
    this.checkBlend(dict)
    const converted=this.doc.context.obj(literal(dict)) as PDFDict,mask=this.maskForm(dict)
    if(mask) {
      const original=dict.lookup(name('SMask')) as PDFDict
      const output=this.doc.context.obj(literal(original)) as PDFDict
      output.set(name('G'),await this.form(mask.stream,scope,state,scope.mask||mask.luminosity,depth))
      const backdrop=original.lookup(name('BC'))
      if(backdrop && !mask.luminosity && !scope.mask) {
        const group=mask.stream.dict.lookup(name('Group'))
        const spec=await this.color(group instanceof PDFDict ? group.lookup(name('CS'))??name('DeviceRGB') : name('DeviceRGB'),scope)
        output.set(name('BC'),this.doc.context.obj(spec.convert(numbers(backdrop))))
      }
      converted.set(name('SMask'),output)
    }
    return converted
  }
  private async convertContent(content:string,scope:Scope,initial:ColorState,depth=0):Promise<string> {
    let state={...initial}
    const stack:ColorState[]=[],out:string[]=[]
    const emitColor=(values:number[],spec:ColorSpec,fill:boolean)=>{
      if(values.length!==spec.channels)throw new Error('PDF 色值通道不匹配')
      if(scope.mask) {
        if(spec.channels!==1)throw new Error('暂不支持彩色亮度蒙版内容')
        return `${values.map(fmt).join(' ')} ${fill?'g':'G'}`
      }
      return `/PrintCMYK ${fill?'cs':'CS'} ${spec.convert(values).map(fmt).join(' ')} ${fill?'scn':'SCN'}`
    }
    for(const ins of parseInstructions(content)) {
      const op=ins.op,fill=['cs','sc','scn','rg','g','k'].includes(op)
      if(op==='q'){stack.push({...state});out.push('q');continue}
      if(op==='Q'){const previous=stack.pop();if(!previous)throw new Error('PDF 图形状态不平衡');state=previous;out.push('Q');continue}
      if(['BT','Tj','TJ',"'",'"'].includes(op))throw new Error('PDF 仍包含未转曲文字，请检查文字图层')
      if(op==='cs'||op==='CS') {
        const sourceName=tokenName(ins.operands[0]?.raw??'')
        const spec=sourceName==='Pattern' ? {key:'pattern',channels:0,convert:()=>[],samples:(b:Uint8Array)=>b} : await this.color(name(sourceName),scope)
        if(fill)state.fill=spec;else state.stroke=spec
        if(scope.mask) {
          const original=this.resource(scope,'ColorSpace',sourceName)
          if(original)this.add(scope,'ColorSpace',sourceName,original)
          out.push(emitInstruction(ins))
        } else out.push(spec.channels===0 ? emitInstruction(ins) : `/PrintCMYK ${op}`)
        continue
      }
      if(['rg','RG','g','G','k','K'].includes(op)) {
        const spec=op.toLowerCase()==='rg'?await this.color(name('DeviceRGB'),scope):op.toLowerCase()==='g'?await this.color(name('DeviceGray'),scope):await this.color(name('DeviceCMYK'),scope)
        if(fill)state.fill=spec;else state.stroke=spec
        out.push(scope.mask ? emitInstruction(ins) : emitColor(instructionNumbers(ins),spec,fill));continue
      }
      if(['sc','SC','scn','SCN'].includes(op)) {
        const spec=fill?state.fill:state.stroke
        if(spec.channels===0) {
          if(ins.operands.length!==1||ins.operands[0].type!=='name')throw new Error('暂不支持非着色图案')
          const pattern=this.resource(scope,'Pattern',tokenName(ins.operands[0].raw))
          if(!(pattern instanceof PDFDict)||number(pattern,'PatternType')!==2)throw new Error('暂不支持平铺图案')
          const converted=this.doc.context.obj({...literal(pattern),Shading:await this.shading(pattern.lookup(name('Shading')),scope)}) as PDFDict
          const gs=pattern.lookup(name('ExtGState'))
          if(gs instanceof PDFDict)converted.set(name('ExtGState'),await this.graphicsState(gs,scope,state,depth))
          const key=`PrintPattern${++this.sequence}`;this.add(scope,'Pattern',key,converted)
          out.push(`/${key} ${op}`)
        } else {
          out.push(scope.mask ? emitInstruction(ins) : emitColor(instructionNumbers(ins),spec,fill))
        }
        continue
      }
      if(op==='Do') {
        const obj=this.resource(scope,'XObject',tokenName(ins.operands[0]?.raw??''))
        if(!(obj instanceof PDFRawStream))throw new Error('PDF XObject 无效')
        let ref:PDFRef
        if(obj.dict.lookup(name('Subtype'))===name('Image')) {
          const mask=scope.mask||obj.dict.lookup(name('ImageMask'))===PDFBool.True
          const work=this.images.get(obj)?.find(w=>w.mask===mask)
          if(!work)throw new Error('PDF 图片使用范围未确定')
          ref=await this.convertImage(work)
        } else if(obj.dict.lookup(name('Subtype'))===name('Form'))ref=await this.form(obj,scope,state,scope.mask,depth)
        else throw new Error('暂不支持此 PDF XObject')
        const key=`PrintObject${++this.sequence}`;this.add(scope,'XObject',key,ref);out.push(`/${key} Do`);continue
      }
      if(op==='gs') {
        const gs=this.resource(scope,'ExtGState',tokenName(ins.operands[0]?.raw??''))
        if(!(gs instanceof PDFDict))throw new Error('PDF 图形状态资源无效')
        const key=`PrintState${++this.sequence}`;this.add(scope,'ExtGState',key,await this.graphicsState(gs,scope,state,depth));out.push(`/${key} gs`);continue
      }
      if(op==='sh') {
        const key=`PrintShading${++this.sequence}`
        this.add(scope,'Shading',key,await this.shading(this.resource(scope,'Shading',tokenName(ins.operands[0]?.raw??'')),scope));out.push(`/${key} sh`);continue
      }
      if(op==='BDC'||op==='DP') {
        const property=ins.operands[1]
        if(property?.type==='name') {
          const key=tokenName(property.raw),value=this.resource(scope,'Properties',key)
          if(!value)throw new Error('PDF 标记属性资源无效')
          this.add(scope,'Properties',key,value)
        }
      }
      if(op==='d0'||op==='d1')throw new Error('PDF 仍包含字体字形内容')
      out.push(emitInstruction(ins))
    }
    if(stack.length)throw new Error('PDF 图形状态不平衡')
    return out.join('\n')
  }
  async run(pages:VectorPagePayload[]):Promise<void> {
    const records=[]
    for(const [index,page] of this.doc.getPages().entries()) {
      const item=pages[index],box=page.getMediaBox(),w=item.widthMm*72/25.4,h=item.heightMm*72/25.4
      if(w<=0||h<=0||box.width<=0||box.height<=0||!Number.isFinite(w+h))throw new Error('PDF 页面尺寸无效')
      const scope=this.scope(undefined,page.node.Resources())
      const text=contents(page.node.Contents()),sx=w/box.width,sy=h/box.height
      const initial:Linear=[sx,0,0,sy]
      await this.collect(text,scope,initial,item.name)
      records.push({page,item,scope,text,sx,sy,w,h,box})
    }
    for(const r of records) {
      const initial={fill:await this.color(name('DeviceGray'),r.scope),stroke:await this.color(name('DeviceGray'),r.scope)}
      const black=initial.fill.convert([0]).map(fmt).join(' ')
      const text=await this.convertContent(r.text,r.scope,initial)
      const transformed=`q\n${r.sx} 0 0 ${r.sy} ${-r.box.x*r.sx} ${-r.box.y*r.sy} cm\n/PrintCMYK cs ${black} scn /PrintCMYK CS ${black} SCN\n${text}\nQ`
      r.page.node.set(name('Contents'),this.doc.context.register(this.doc.context.flateStream(contentBytes(transformed))))
      r.page.node.set(name('Resources'),r.scope.out)
      const group=r.page.node.lookup(name('Group'))
      if(group instanceof PDFDict)r.page.node.set(name('Group'),this.doc.context.obj({...literal(group),CS:this.colorSpace}))
      r.page.setMediaBox(0,0,r.w,r.h);r.page.setCropBox(0,0,r.w,r.h)
      const pad=r.item.trimInsetMm*72/25.4,bleedPad=Math.max(0,pad-r.item.bleedMm*72/25.4)
      if(r.w<=2*pad||r.h<=2*pad)throw new Error('成品框尺寸无效')
      r.page.setTrimBox(pad,pad,r.w-2*pad,r.h-2*pad)
      r.page.setBleedBox(bleedPad,bleedPad,r.w-2*bleedPad,r.h-2*bleedPad)
      await new Promise(resolve=>setTimeout(resolve,0))
    }
  }
}

export async function buildCmykVectorPdf(pages:VectorPagePayload[],profile:PrintProfile,dpi=300):Promise<{bytes:Uint8Array;warnings:string[]}> {
  if(!pages.length)throw new Error('没有可导出的印刷版')
  if(![150,300,600].includes(dpi))throw new Error('请选择有效的打印 DPI')
  const doc=await PDFDocument.create()
  for(const item of pages) {
    const input=await PDFDocument.load(item.bytes)
    if(input.getPageCount()!==1)throw new Error('每个印刷版应对应一页 PDF')
    doc.addPage((await doc.copyPages(input,[0]))[0])
  }
  const conversion=new VectorConversion(doc,profile,dpi)
  try {
    await conversion.init();await conversion.run(pages)
    // Copy only reachable converted objects: remove unused RGB resources and original images.
    const clean=await PDFDocument.create()
    for(const page of await clean.copyPages(doc,doc.getPageIndices()))clean.addPage(page)
    const spaces=clean.getPage(0).node.Resources()!.lookup(name('ColorSpace')) as PDFDict
    const cs=spaces.lookup(name('PrintCMYK')) as PDFArray,icc=cs.get(1)
    const label=profile.name.replace(/[^\x20-\x7E]/g,' ').trim()||'Custom CMYK ICC'
    const intent=clean.context.register(clean.context.obj({Type:'OutputIntent',S:'GTS_PDFX',DestOutputProfile:icc,OutputConditionIdentifier:PDFString.of(label),Info:PDFString.of(label)}))
    clean.catalog.set(name('OutputIntents'),clean.context.obj([intent]))
    clean.setCreator('Print Assistant / vector outlines / LittleCMS ICC')
    clean.setProducer('Print Assistant / pdf-lib / LittleCMS')
    return {bytes:await clean.save({useObjectStreams:false}),warnings:[...conversion.warnings]}
  } catch(error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}。可手动切换“整页栅格”模式重新导出。`)
  } finally {conversion.dispose()}
}

export async function convertVectorPdfToCmyk(pdfBytes:Uint8Array,profile:PrintProfile,dpi=300):Promise<Uint8Array> {
  const input=await PDFDocument.load(pdfBytes),page=input.getPage(0)
  return (await buildCmykVectorPdf([{kind:'vector',bytes:pdfBytes,name:'PDF',widthMm:page.getWidth()*25.4/72,heightMm:page.getHeight()*25.4/72,trimInsetMm:0,bleedMm:0}],profile,dpi)).bytes
}
