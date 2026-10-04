// Small complete validator for the JSON Schema vocabulary used by our pinned schema.
// Unknown validation vocabulary is a kernel authoring error, never ignored.
export function validateSchema(value,schema,document=schema,location='$') {
  if(schema.$ref){const parts=schema.$ref.replace(/^#\//,'').split('/');let resolved=document;for(const part of parts)resolved=resolved[part];return validateSchema(value,resolved,document,location);}
  if(schema.anyOf){if(!schema.anyOf.some(x=>{try{validateSchema(value,x,document,location);return true;}catch{return false;}}))throw new Error('SCHEMA_ANY_OF: '+location);return;}
  const type=value===null?'null':Array.isArray(value)?'array':typeof value==='number'&&Number.isInteger(value)?'integer':typeof value;
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  if(schema.type&&!types.includes(type)&&!(type==='integer'&&types.includes('number')))throw new Error('SCHEMA_TYPE: '+location);
  if(schema.const!==undefined&&value!==schema.const)throw new Error('SCHEMA_CONST: '+location);
  if(schema.enum&&!schema.enum.includes(value))throw new Error('SCHEMA_ENUM: '+location);
  if(typeof value==='string'&&((schema.minLength!==undefined&&value.length<schema.minLength)||(schema.pattern&&!new RegExp(schema.pattern).test(value))))throw new Error('SCHEMA_STRING: '+location);
  if(typeof value==='number'&&(!Number.isFinite(value)||(schema.minimum!==undefined&&value<schema.minimum)||(schema.maximum!==undefined&&value>schema.maximum)))throw new Error('SCHEMA_NUMBER: '+location);
  if(type==='array') {if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)throw new Error('SCHEMA_DUPLICATE: '+location);if(schema.items)value.forEach((x,i)=>validateSchema(x,schema.items,document,location+'['+i+']'));}
  if(type==='object') {
    if(schema.required?.some(k=>!Object.hasOwn(value,k)))throw new Error('SCHEMA_REQUIRED: '+location);
    for(const key of Object.keys(value)){if(schema.properties?.[key])validateSchema(value[key],schema.properties[key],document,location+'.'+key);
      else if(schema.additionalProperties===false)throw new Error('SCHEMA_EXTRA: '+location+'.'+key);
      else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validateSchema(value[key],schema.additionalProperties,document,location+'.'+key);}
  }
}
