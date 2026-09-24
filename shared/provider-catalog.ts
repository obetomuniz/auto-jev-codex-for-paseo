import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const catalogSchema = z.array(z.object({
  id: z.string(), label: z.string(),
  modes: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  models: z.array(z.object({
    id: z.string(), label: z.string(),
    efforts: z.array(z.object({ id: z.string(), label: z.string() })),
  })),
  error: z.string().optional(),
}));
export const getProviderCatalogRpc = defineRpc({ name: "providers.list", input: z.object({}), output: catalogSchema });
