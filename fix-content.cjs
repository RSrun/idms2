const fs = require('fs');
let c = fs.readFileSync('extension/shared/content.js', 'utf8');
c = c.replace(/type: 'idms-download'/g, "type: 'download'");
c = c.replace(/type: 'idms-instagram-download'/g, "type: 'download'");
c = c.replace(/type: 'idms-youtube-download'/g, "type: 'download-media'");
c = c.replace(/type: 'idms-fetch'/g, "type: 'fetch'");
c = c.replace(/type: 'idms-manifest-found'/g, "type: 'manifest-found'");
c = c.replace(/type: 'idms-youtube-formats'/g, "type: 'youtube-formats'");
c = c.replace(/type: 'idms-status'/g, "type: 'ping'");
c = c.replace(/type: 'idms-pair'/g, "type: 'hello'");
fs.writeFileSync('extension/shared/content.js', c);
console.log('Fixed content.js messages');


