import type { z } from "zod";
export type ToolAdder = <S extends Record<string, z.ZodType>>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>, options?: { write?: boolean; local?: boolean; dev?: boolean; destructive?: boolean }) => void;
