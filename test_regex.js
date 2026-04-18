
const template = '{{#hasGroundingContext}}\nHELLO WORLD\n{{/hasGroundingContext}}';
const variables = { hasGroundingContext: true, groundingContext: 'TEST' };
let result = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, flag, content) => variables[flag] ? content : '');
console.log(result);

