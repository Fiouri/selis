const fs = require("fs");
const { selisBench } = require("./bench-core.cjs");
const cv = require("./opencv.cjs");
selisBench(cv, fs.readFileSync("selis_scan.wasm"), { iterations: 200 }).then((r) => console.log(JSON.stringify(r, null, 1)), (e) => { console.error(e); process.exit(1); });
