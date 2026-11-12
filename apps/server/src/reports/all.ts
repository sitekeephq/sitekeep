/**
 * Loads every report dataset into the registry: the built-in ones (datasets.ts), the module
 * datasets, the model dataset and the datasets of installed modules. Import this (not datasets.ts) wherever the full catalog is needed.
 */
import "./datasets-works.js";
import "./datasets-modules.js";
import "../model/report-dataset.js";
// Module datasets register when their module loads.
import "../app/modules.js";

export { reportDatasets } from "./datasets.js";
