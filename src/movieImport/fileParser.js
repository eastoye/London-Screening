import { unzipSync, strFromU8 } from "fflate";
import { parseCsvInput } from "./csvParser.js";
import { IMPORT_SOURCE } from "./model.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

function ensureFileSize(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error("The import file must be 10 MB or smaller.");
  }
}

function parseLetterboxdZip(buffer, filename) {
  const files = unzipSync(new Uint8Array(buffer));
  const supported = Object.entries(files).filter(([name]) =>
    /(^|\/)(watchlist|ratings)\.csv$/i.test(name)
  );
  const totalBytes = supported.reduce((total, [, data]) => total + data.length, 0);

  if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new Error("The uncompressed Letterboxd export is too large.");
  }
  if (supported.length === 0) {
    throw new Error("The ZIP does not contain Letterboxd watchlist.csv or ratings.csv.");
  }

  return supported.flatMap(([name, data]) =>
    parseCsvInput(strFromU8(data), {
      filename: `${filename}:${name}`,
      source: IMPORT_SOURCE.LETTERBOXD,
    })
  );
}

export async function parseImportFile(file) {
  ensureFileSize(file);
  const filename = file.name || "upload";

  if (/\.zip$/i.test(filename)) {
    return parseLetterboxdZip(await file.arrayBuffer(), filename);
  }

  if (!/\.(csv|tsv|txt)$/i.test(filename)) {
    throw new Error("Upload a CSV, TSV, text file, or Letterboxd ZIP export.");
  }

  return parseCsvInput(await file.text(), { filename });
}
