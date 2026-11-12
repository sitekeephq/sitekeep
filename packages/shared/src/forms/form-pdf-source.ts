/** Leaf source-PDF metadata shared by forms and PDF processing. */
export const PDF_DETECTION_LEVELS = ["acroform", "text", "scanned"] as const;
export type PdfDetectionLevel = (typeof PDF_DETECTION_LEVELS)[number];

export const PDF_DETECTION_LABELS_TR: Record<PdfDetectionLevel, string> = {
  acroform: "Doldurulabilir PDF (AcroForm)",
  text: "Metin Katmanlı PDF",
  scanned: "Taranmış PDF",
};

export interface FormPdfPageDto {
  width: number;
  height: number;
  /** Bounding box of printed content [x0, y0, x1, y1]. */
  content: [number, number, number, number] | null;
}

export interface FormPdfSourceDto {
  id: string;
  fileName: string;
  size: number;
  sha256: string;
  pageCount: number;
  pages: FormPdfPageDto[];
  level: PdfDetectionLevel;
  fieldCount: number;
  createdAt: string;
}
