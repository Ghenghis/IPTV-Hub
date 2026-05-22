const http = require('http');
const port = Number(process.env.PORT || 3000);
http.createServer((_, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('ok'); })
  .listen(port, () => console.log('listening', port));
