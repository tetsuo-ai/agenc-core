import {test,expect} from 'vitest';
import {normalizeModelToolArgs} from '../../src/tools/argument-validation.js';
const wrap=(value:any)=>({type:'object',properties:{value},required:['value']});
test.each([
 {type:['array','string','null'],minLength:20},
 {anyOf:[{type:'array'},{type:'string',minLength:20},{type:'null'}]},
 {oneOf:[{type:'array'},{type:'string',minLength:20},{type:'null'}]},
 {type:['array','string'],nullable:true,minLength:20},
])('review: constrained nullable string union is never repaired %j',schema=>{
 expect(normalizeModelToolArgs(wrap(schema),{value:'[]'}).valid).toBe(false);
});
test('review: referenced string union is never repaired',()=>{
 const schema={...wrap({$ref:'#/$defs/value'}),$defs:{value:{anyOf:[{type:'array'},{type:'string',minLength:20}]}}};
 expect(normalizeModelToolArgs(schema,{value:'[]'}).valid).toBe(false);
});
test('review: nullable array parses array but never null',()=>{
 expect(normalizeModelToolArgs(wrap({type:['array','null']}),{value:'[]'}).args).toEqual({value:[]});
 expect(normalizeModelToolArgs(wrap({type:['array','null']}),{value:'null'}).valid).toBe(false);
});
test('review: prototype-shaped object remains data',()=>{
 const result=normalizeModelToolArgs(wrap({type:'object',additionalProperties:{type:'array'}}),{value:'{"__proto__":"[]"}'});
 expect(result.valid).toBe(true);
 expect(Object.hasOwn(result.args!.value as object,'__proto__')).toBe(true);
 expect(Object.getPrototypeOf(result.args!.value)).toBe(Object.prototype);
});
