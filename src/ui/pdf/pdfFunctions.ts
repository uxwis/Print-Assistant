import { PDFArray, PDFDict, PDFNumber, PDFRawStream, PDFName, decodePDFRawStream, type PDFObject } from 'pdf-lib'
import { calculatorFunction } from './calculatorFunction'

export function numbers(obj:PDFObject|undefined): number[] {
  if (!(obj instanceof PDFArray)) throw new Error('PDF 数组无效')
  const out:number[]=[]
  for(let i=0;i<obj.size();i++) {
    const value=obj.lookup(i)
    if (!(value instanceof PDFNumber) || !Number.isFinite(value.asNumber())) throw new Error('PDF 数组包含无效数值')
    out.push(value.asNumber())
  }
  return out
}
export function number(dict:PDFDict,key:string,fallback?:number): number {
  const obj=dict.lookup(PDFName.of(key))
  if (obj===undefined && fallback!==undefined) return fallback
  if (!(obj instanceof PDFNumber) || !Number.isFinite(obj.asNumber())) throw new Error(`PDF ${key} 无效`)
  return obj.asNumber()
}
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n))

// Bounded one-input sampled, exponential, stitching and calculator functions.
export function pdfFunction(obj:PDFObject|undefined): {domain:number[];evaluate:(x:number)=>number[]} {
  if (obj instanceof PDFArray) {
    const functions: {domain:number[];evaluate:(x:number)=>number[]}[]=[]
    for(let i=0;i<obj.size();i++) functions.push(pdfFunction(obj.lookup(i)))
    if (!functions.length) throw new Error('PDF 渐变函数为空')
    return {domain:functions[0].domain,evaluate:x=>functions.flatMap(f=>f.evaluate(x))}
  }
  const dict=obj instanceof PDFRawStream ? obj.dict : obj
  if (!(dict instanceof PDFDict)) throw new Error('PDF 渐变函数无效')
  const type=number(dict,'FunctionType'), domain=numbers(dict.lookup(PDFName.of('Domain')))
  if(domain.length!==2 || domain[1]<=domain[0]) throw new Error('暂不支持多维或无效渐变函数')
  const rangeObj=dict.lookup(PDFName.of('Range')), range=rangeObj ? numbers(rangeObj) : undefined
  if(range && (!range.length || range.length%2 || range.some((v,i)=>i%2===1 && v<range[i-1])))throw new Error('PDF 渐变输出范围无效')
  let evaluate:(x:number)=>number[]
  if (type===2) {
    const c0Obj=dict.lookup(PDFName.of('C0')),c1Obj=dict.lookup(PDFName.of('C1'))
    const c0=c0Obj ? numbers(c0Obj) : [0], c1=c1Obj ? numbers(c1Obj) : [1], exponent=number(dict,'N')
    if(c0.length!==c1.length) throw new Error('PDF 渐变通道不匹配')
    evaluate=x=>c0.map((v,i)=>v+Math.pow(x,exponent)*(c1[i]-v))
  } else if(type===3) {
    const list=dict.lookup(PDFName.of('Functions'))
    if(!(list instanceof PDFArray)) throw new Error('PDF 分段渐变无效')
    const children: {domain:number[];evaluate:(x:number)=>number[]}[]=[]
    for(let i=0;i<list.size();i++) children.push(pdfFunction(list.lookup(i)))
    const bounds=numbers(dict.lookup(PDFName.of('Bounds'))),encode=numbers(dict.lookup(PDFName.of('Encode')))
    const edges=[domain[0],...bounds,domain[1]]
    if(bounds.length!==children.length-1 || encode.length!==children.length*2 || edges.some((v,i)=>i>0&&v<=edges[i-1])) throw new Error('PDF 分段渐变范围无效')
    evaluate=x=>{
      let i=0
      while(i<children.length-1 && x>=edges[i+1]) i++
      const mapped=encode[2*i]+(x-edges[i])/(edges[i+1]-edges[i])*(encode[2*i+1]-encode[2*i])
      return children[i].evaluate(mapped)
    }
  } else if(type===0 && obj instanceof PDFRawStream) {
    const size=numbers(dict.lookup(PDFName.of('Size'))),bits=number(dict,'BitsPerSample')
    if(size.length!==1 || !Number.isInteger(size[0]) || size[0]<1 || size[0]>65536 || number(dict,'Order',1)!==1 || ![1,2,4,8,12,16,24,32].includes(bits) || !range || range.length%2) throw new Error('暂不支持此采样渐变函数')
    const channels=range.length/2, bytes=decodePDFRawStream(obj).decode()
    if(channels<1 || channels>4 || bytes.length*8<size[0]*channels*bits) throw new Error('PDF 渐变采样数据不完整')
    const encodeObj=dict.lookup(PDFName.of('Encode')),decodeObj=dict.lookup(PDFName.of('Decode'))
    const encode=encodeObj ? numbers(encodeObj) : [0,size[0]-1], decode=decodeObj ? numbers(decodeObj) : range
    if(encode.length!==2 || decode.length!==range.length) throw new Error('PDF 渐变编码无效')
    const sample=(index:number)=>{
      let result=0, offset=index*bits
      for(let bit=0;bit<bits;bit++,offset++) result=result*2+((bytes[offset>>3]>>(7-(offset&7)))&1)
      return result/(2**bits-1)
    }
    evaluate=x=>{
      const at=clamp(encode[0]+(x-domain[0])/(domain[1]-domain[0])*(encode[1]-encode[0]),0,size[0]-1)
      const lo=Math.floor(at),hi=Math.ceil(at),t=at-lo
      return Array.from({length:channels},(_,c)=>{
        const value=sample(lo*channels+c)*(1-t)+sample(hi*channels+c)*t
        return decode[2*c]+value*(decode[2*c+1]-decode[2*c])
      })
    }
  } else if(type===4 && obj instanceof PDFRawStream) {
    if(!range || range.length>8)throw new Error('PDF Type 4 渐变输出范围无效')
    evaluate=calculatorFunction(decodePDFRawStream(obj).decode(),range.length/2)
  } else throw new Error(`暂不支持 PDF 渐变函数类型 ${type}`)
  return {domain,evaluate:x=>{
    const values=evaluate(clamp(x,domain[0],domain[1]))
    if(values.some(v=>!Number.isFinite(v)) || (range && range.length!==values.length*2)) throw new Error('PDF 渐变函数返回无效色值')
    return range ? values.map((v,i)=>clamp(v,range[i*2],range[i*2+1])) : values
  }}
}
