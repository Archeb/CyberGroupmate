
import { renderTemplate } from './src/main-agent/prompt-renderer.js';

const template = '{{#hasGroundingContext}}\n## 事实查证\n以下是通过联网搜索获得的相关事实信息，请在回复中参考（如涉及事实性内容）：\n{{groundingContext}}\n{{/hasGroundingContext}}';
const vars = { hasGroundingContext: true, groundingContext: 'TEST TEST TEST' };

console.log('Result length:', renderTemplate(template, vars).length);
console.log('--- RESULT ---');
console.log(renderTemplate(template, vars));

