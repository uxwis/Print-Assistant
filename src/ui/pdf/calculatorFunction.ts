// PDF Type 4 calculator functions: a bounded, data-only PostScript subset.
// Never execute PDF source as JavaScript. Procedures can only run via if/ifelse.
type Procedure = { code: Instruction[] }
type Value = number | boolean | Procedure
type Instruction = Value | string
const unary:Record<string,(x:number)=>number> = {
  abs:Math.abs, neg:x=>-x, ceiling:Math.ceil, floor:Math.floor,
  round:Math.round, truncate:Math.trunc, cvi:Math.trunc, cvr:x=>x,
  sqrt:Math.sqrt, ln:Math.log, log:Math.log10,
  sin:x=>Math.sin((x%360)*Math.PI/180), cos:x=>Math.cos((x%360)*Math.PI/180),
}
const binary:Record<string,(a:number,b:number)=>number|boolean> = {
  add:(a,b)=>a+b, sub:(a,b)=>a-b, mul:(a,b)=>a*b, div:(a,b)=>a/b,
  idiv:(a,b)=>Math.trunc(a/b), mod:(a,b)=>a%b, exp:(a,b)=>a**b,
  atan:(a,b)=>{if(a===0&&b===0)throw new Error('PDF 计算函数角度无效');return (Math.atan2(a,b)*180/Math.PI+360)%360},
  ge:(a,b)=>a>=b, gt:(a,b)=>a>b, le:(a,b)=>a<=b, lt:(a,b)=>a<b,
}
const operators=new Set([...Object.keys(unary),...Object.keys(binary),
  'true','false','and','or','xor','not','bitshift','eq','ne','copy','dup','exch','index','pop','roll','if','ifelse'])
const invalid=():never=>{throw new Error('PDF Type 4 渐变计算函数格式或操作数无效')}
const integer=(v:Value):number=>typeof v==='number'&&Number.isInteger(v)&&v>=-2147483648&&v<=2147483647?v:invalid()

export function calculatorFunction(bytes:Uint8Array,channels:number):(x:number)=>number[] {
  if(bytes.length>65536)throw new Error('PDF Type 4 渐变计算函数过大')
  let source=''
  for(const byte of bytes)source+=String.fromCharCode(byte)
  const tokens=source.replace(/%[^\r\n]*/g,'').match(/[{}]|[^\s\0{}]+/g)??[]
  if(tokens.length>8192)throw new Error('PDF Type 4 渐变计算函数过长')
  let at=0
  const parse=(depth:number):Procedure=>{
    if(depth>32 || tokens[at++]!=='{')return invalid()
    const code:Instruction[]=[]
    while(at<tokens.length) {
      const token=tokens[at++]
      if(token==='}')return {code}
      if(token==='{'){at--;code.push(parse(depth+1))}
      else if(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
        const value=Number(token);if(!Number.isFinite(value))return invalid();code.push(value)
      } else if(operators.has(token))code.push(token)
      else throw new Error(`暂不支持 PDF Type 4 计算操作符 ${token.slice(0,40)}`)
    }
    return invalid()
  }
  const program=parse(0)
  if(at!==tokens.length)return invalid()
  return x=>{
    const stack:Value[]=[x]
    let budget=20000
    const pop=():Value=>stack.length?stack.pop()!:invalid()
    const num=():number=>{const value=pop();return typeof value==='number'?value:invalid()}
    const push=(value:Value)=>{
      if(stack.length>=256)throw new Error('PDF Type 4 计算栈过大')
      if(typeof value==='number'&&!Number.isFinite(value))return invalid()
      stack.push(value)
    }
    const count=()=>{const n=integer(pop());return n>=0&&n<=stack.length?n:invalid()}
    const procedure=():Procedure=>{const value=pop();return typeof value==='object'?value:invalid()}
    const run=(proc:Procedure,depth:number)=>{
      if(depth>32)return invalid()
      for(const op of proc.code) {
        if(--budget<0)throw new Error('PDF Type 4 渐变计算量过大')
        if(typeof op!=='string'){push(op);continue}
        if(Object.prototype.hasOwnProperty.call(unary,op)){push(unary[op](num()));continue}
        if(Object.prototype.hasOwnProperty.call(binary,op)){const b=num(),a=num();push(binary[op](a,b));continue}
        switch(op) {
          case 'true':push(true);break
          case 'false':push(false);break
          case 'pop':pop();break
          case 'dup':{const a=pop();push(a);push(a);break}
          case 'exch':{const b=pop(),a=pop();push(b);push(a);break}
          case 'copy':{const n=count();for(const value of stack.slice(stack.length-n))push(value);break}
          case 'index':{const n=integer(pop());if(n<0||n>=stack.length)return invalid();push(stack[stack.length-1-n]);break}
          case 'roll':{
            const shift=integer(pop()),n=count()
            if(n){const k=((shift%n)+n)%n,values=stack.splice(stack.length-n);for(const value of [...values.slice(n-k),...values.slice(0,n-k)])push(value)}
            break
          }
          case 'eq':case 'ne':{const b=pop(),a=pop();push(op==='eq'?a===b:a!==b);break}
          case 'and':case 'or':case 'xor':{
            const b=pop(),a=pop()
            if(typeof a==='boolean'&&typeof b==='boolean')push(op==='and'?a&&b:op==='or'?a||b:a!==b)
            else {const ai=integer(a),bi=integer(b);push(op==='and'?ai&bi:op==='or'?ai|bi:ai^bi)}
            break
          }
          case 'not':{const a=pop();push(typeof a==='boolean'?!a:~integer(a));break}
          case 'bitshift':{const shift=integer(pop()),a=integer(pop());push(Math.abs(shift)>=32?0:shift>=0?a<<shift:(a>>>-shift)|0);break}
          case 'if':case 'ifelse':{
            const last=procedure(),first=op==='ifelse'?procedure():last,condition=pop()
            if(typeof condition!=='boolean')return invalid()
            if(condition)run(first,depth+1);else if(op==='ifelse')run(last,depth+1)
            break
          }
          default:return invalid()
        }
      }
    }
    run(program,0)
    if(stack.length<channels)return invalid()
    return stack.slice(-channels).map(value=>typeof value==='number'?value:invalid())
  }
}
