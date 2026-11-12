/**
 * Zod shapes of the optional viewer state saved with issue viewpoints and model set views:
 * section planes / box (Kesit) and measurements (Ölçü). Both fields are optional, so older
 * viewpoints stay valid and older clients simply do not send them.
 */
import { z } from "zod";

const num = z.number().finite();
const vec3 = z.tuple([num, num, num]);

export const viewpointSectionsSchema = z.object({
  planes: z.array(z.object({ origin: vec3, normal: vec3, enabled: z.boolean().optional() })).max(32).default([]),
  box: z.object({ min: vec3, max: vec3 }).nullable().optional(),
});

export const viewpointMeasurementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("length"), points: z.tuple([vec3, vec3]), value: num }),
  z.object({ kind: z.literal("area"), points: z.array(vec3).min(3).max(500), value: num }),
  z.object({ kind: z.literal("angle"), points: z.tuple([vec3, vec3, vec3]), value: num }),
  z.object({ kind: z.literal("volume"), guids: z.array(z.string().max(64)).min(1).max(5000), value: num }),
]);

/** Spread into a viewpoint / view state object schema. */
export const viewerStateFields = {
  sections: viewpointSectionsSchema.optional(),
  measurements: z.array(viewpointMeasurementSchema).max(200).optional(),
};

const guidList = z.array(z.string().max(64)).max(20000);

/** Camera of an issue viewpoint; up / fov / aspect / viewToWorldScale are optional (BCF cameras). */
export const viewpointCameraSchema = z.object({
  position: vec3,
  target: vec3,
  projection: z.enum(["perspective", "orthographic"]),
  up: vec3.optional(),
  fov: z.number().gt(0).lt(180).optional(),
  aspect: z.number().positive().max(100).optional(),
  viewToWorldScale: z.number().positive().optional(),
});

/** Optional BCF fields of an issue viewpoint (docs/features/BCF.md); older clients do not send them. */
export const viewpointBcfFields = {
  guid: z.string().uuid().optional(),
  sceneOffset: vec3.optional(),
  visibility: z
    .object({
      defaultVisible: z.boolean(),
      exceptions: guidList,
      spacesVisible: z.boolean().optional(),
      spaceBoundariesVisible: z.boolean().optional(),
      openingsVisible: z.boolean().optional(),
    })
    .optional(),
  coloring: z
    .array(z.object({ color: z.string().regex(/^([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/), guids: guidList }))
    .max(100)
    .optional(),
  lines: z.array(z.tuple([vec3, vec3])).max(2000).optional(),
  snapshotOnly: z.boolean().optional(),
};
