import http from 'http'; import fs from 'fs';
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
http.createServer((req, res) => {
  // Vercel-rewrite simulator: 200 + index.html for ALL paths (including missing module)
  res.writeHead(200, {'Content-Type': 'text/html'});
  res.end(html);
}).listen(8766, () => console.log('chunk-fail fixture on 8766'));
