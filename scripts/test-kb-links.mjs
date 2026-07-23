// 临时测试 KB Links API
import http from 'http';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:4567' + path, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(path, data) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:4567' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(data));
    req.end();
  });
}

const r = await get('/api/kb');
const data = JSON.parse(r.body).data;
console.log('=== /api/kb ===');
console.log('categories:', data.categories.length);
console.log('items:', data.items.length);
console.log('links:', (data.links || []).length);
if (data.links && data.links.length) {
  data.links.forEach(l => console.log('  - ' + l.source_id + ' → ' + l.target_id + ' (' + l.type + ')' + (l.label ? ' [' + l.label + ']' : '')));
}

const items = data.items;
const item1 = items[0];
const item2 = items[items.length - 1];

console.log('\n=== 创建测试关联 ===');
const createR = await post('/api/kb/links', { source_id: item1.id, target_id: item2.id, type: 'related', label: 'test link' });
console.log('status:', createR.status);
console.log('body:', createR.body);

console.log('\n=== 重复创建（应 400）===');
const dupR = await post('/api/kb/links', { source_id: item1.id, target_id: item2.id, type: 'related' });
console.log('status:', dupR.status);

console.log('\n=== 自环（应 400）===');
const selfR = await post('/api/kb/links', { source_id: item1.id, target_id: item1.id, type: 'related' });
console.log('status:', selfR.status);

console.log('\n=== 列表 ===');
const listR = await get('/api/kb/links');
console.log('total:', JSON.parse(listR.body).data.total);
