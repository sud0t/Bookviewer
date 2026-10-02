import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Character maps, fonts and decoders that pdf.js loads on demand (see the Vite config). */
const ASSETS = new URL('./pdfjs/', document.baseURI).href

export function loadPdf(url: string): pdfjs.PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    url,
    cMapUrl: ASSETS + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSETS + 'standard_fonts/',
    wasmUrl: ASSETS + 'wasm/',
    iccUrl: ASSETS + 'iccs/',
    // Fetch byte ranges as pages need them rather than the whole file.
    disableAutoFetch: true,
    disableStream: true,
    rangeChunkSize: 1 << 18,
  })
}

export { pdfjs }
