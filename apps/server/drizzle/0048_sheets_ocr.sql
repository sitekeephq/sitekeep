ALTER TABLE "drawing_sheet_settings" ADD COLUMN "title_block" jsonb;--> statement-breakpoint
ALTER TABLE "drawing_sheet_settings" ADD COLUMN "ocr" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD COLUMN "read_by" text;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD COLUMN "ocr_confidence" real;--> statement-breakpoint
ALTER TABLE "drawing_sheets" ADD COLUMN "from_template" boolean DEFAULT false NOT NULL;