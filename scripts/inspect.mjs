// 探查当前 KB / WF 数据
import http from 'http';
function get(p) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4567' + p, (r) => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({status: r.statusCode, body: b}));
    }).on('error', reject);
  });
}
const kb = JSON.parse((await get('/api/kb')).body).data;
const wf = JSON.parse((await get('/api/wf')).body).data;
console.log('=== KB ===');
console.log('  categories:', kb.categories.length);
kb.categories.forEach(c => console.log('   -', c.icon, c.name));
console.log('  items:', kb.items.length);
kb.items.forEach(i => console.log('   -', i.title, '/', (i.tags || []).join(',')));
console.log('  links:', (kb.links || []).length);
(kb.links || []).forEach(l => console.log('   -', l.type, '|', l.label || '(no label)'));
console.log('\n=== WF ===');
wf.forEach(w => {
  console.log('  -', w.icon, w.name, '(' + w.steps.length + ' 步)');
  w.steps.forEach(s => console.log('     ·', s.name, '|', s.content.slice(0, 30)));
});
