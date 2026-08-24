import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require(
  "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel",
);

export function qrSvg(payload: string): string {
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount() as number;
  const quiet = 4;
  const size = count + quiet * 2;
  const cells: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) {
        cells.push(`M${column + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="DSH mobile pairing QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${cells.join("")}" fill="#111"/></svg>`;
}
