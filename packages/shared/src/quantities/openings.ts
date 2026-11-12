/**
 * Openings measured from IFC geometry (docs/features/METRAJ.md "Boşluklar"): every IfcOpeningElement
 * voiding a host (IfcRelVoidsElement) is read as extruded solids (profile area, profile bounding box,
 * extrusion height; metres). Exporters orient openings differently: Revit often draws a wall opening's
 * profile in plan and extrudes it upwards, others draw it on the wall face and extrude it through the
 * wall. The side that passes through the host is the shortest side at least as long as the host's
 * thickness (or the shortest side when the thickness is unknown); the opening's face area is what
 * the other two sides span.
 */

/** One extruded solid of an opening: [profile area m², profile width m, profile height m, extrusion m]. */
export type OpeningSolid = [number, number, number, number];
