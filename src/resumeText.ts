/// <reference types="vite/client" />
/**
 * resumeText.ts
 * The text of a resume file, read in this browser. Nothing is uploaded:
 * a PDF is parsed with pdf.js (loaded only when someone picks a file),
 * and a .txt or .md file is read as it is.
 */

export async function resumeText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) return pdfText(file);
  if (file.type.startsWith("text/") || /\.(txt|md|text)$/.test(name)) return file.text();
  throw new Error("Use a PDF or a plain-text file. For Word, save as PDF first, or paste the text.");
}

async function pdfText(file: File): Promise<string> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, 6); i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    let page = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      page += item.str + (item.hasEOL ? "\n" : "");
    }
    pages.push(page);
  }
  await task.destroy();
  const text = pages.join("\n").trim();
  if (text.length < 200) throw new Error("This PDF has almost no text in it (it may be a scanned image). Paste the text instead.");
  return text;
}
