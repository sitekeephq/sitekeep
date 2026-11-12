/**
 * Delivery channels for works (letters, transmittals).
 *
 * A channel takes a work that is ready to go out and reports how far delivery got. Today every
 * channel is manual or in-app: nothing leaves the server. A real KEP (Kayıtlı Elektronik Posta)
 * provider or an SMTP channel implements the same interface later and registers itself in
 * DELIVERY_CHANNELS; the routes and the UI do not change. See docs/features/WORKS.md.
 */
import type { DeliveryChannelDto, DeliveryStatus } from "@sitekeep/shared";
import { DEFAULT_LANGUAGE, msg, render, type Msg } from "../i18n/index.js";

export interface DeliveryAttachment {
  fileName: string;
  version: number;
  size: number;
  storageKey: string;
  /** Marked as an e-signed (PAdES) PDF by the user. Not verified yet. */
  signed: boolean;
}

export interface DeliveryRequest {
  projectId: string;
  workId: string;
  number: string;
  title: string;
  fromCompany: string | null;
  toCompanies: string[];
  ccCompanies: string[];
  attachments: DeliveryAttachment[];
  /** Reference typed by the user for manual channels (KEP gönderim no, tutanak no…). */
  reference: string | null;
  note: string | null;
}

export interface DeliveryResult {
  status: DeliveryStatus;
  reference: string | null;
  message?: string;
}

export interface DeliveryChannel {
  readonly id: string;
  /** Shown in the reader's language (render). */
  readonly label: Msg;
  readonly description: Msg;
  /** The user enters the reference and later updates the status by hand. */
  readonly manual: boolean;
  /** Sending needs at least one attachment flagged as an e-signed PDF. */
  readonly requiresSignedPdf: boolean;
  send(req: DeliveryRequest): Promise<DeliveryResult>;
  /**
   * Polls the provider for the current state (KEP delivery receipt, bounce…). Manual channels
   * return null: the status is whatever the user recorded.
   */
  refresh?(reference: string): Promise<DeliveryResult | null>;
}

/** In-app delivery: recipients see the work in the CDE and get a notification. */
class CdeChannel implements DeliveryChannel {
  readonly id = "cde";
  readonly label = msg("works:delivery.cde");
  readonly description = msg("works:delivery.cdeDescription");
  readonly manual = false;
  readonly requiresSignedPdf = false;
  async send(): Promise<DeliveryResult> {
    return { status: "delivered", reference: null };
  }
}

/** Records a delivery done outside the system (by hand, e-mail, KEP web portal). */
class ManualChannel implements DeliveryChannel {
  readonly manual = true;
  constructor(
    readonly id: string,
    readonly label: Msg,
    readonly description: Msg,
    readonly requiresSignedPdf = false,
  ) {}
  async send(req: DeliveryRequest): Promise<DeliveryResult> {
    return { status: "sent", reference: req.reference };
  }
}

export const DELIVERY_CHANNELS: DeliveryChannel[] = [
  new CdeChannel(),
  new ManualChannel("elden", msg("works:delivery.byHand"), msg("works:delivery.byHandDescription")),
  new ManualChannel("eposta", msg("works:delivery.email"), msg("works:delivery.emailDescription")),
  new ManualChannel("kep", msg("works:delivery.kep"), msg("works:delivery.kepDescription"), true),
];

export function deliveryChannel(id: string): DeliveryChannel | undefined {
  return DELIVERY_CHANNELS.find((c) => c.id === id);
}

export function toChannelDto(c: DeliveryChannel, lang: string = DEFAULT_LANGUAGE): DeliveryChannelDto {
  return {
    id: c.id,
    label: render(lang, c.label),
    manual: c.manual,
    requiresSignedPdf: c.requiresSignedPdf,
    description: render(lang, c.description),
  };
}
