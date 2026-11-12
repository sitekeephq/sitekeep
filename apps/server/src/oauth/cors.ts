import type { FastifyReply } from "fastify";

/** Browser OpenCDE clients may call the token endpoints from another origin (no cookies involved). */
export function setOpenCdeCors(reply: FastifyReply) {
  reply
    .header("Access-Control-Allow-Origin", "*")
    .header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
    .header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    .header("Access-Control-Max-Age", "600");
}
