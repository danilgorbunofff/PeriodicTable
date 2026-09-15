import { notFound } from "next/navigation";
import { getProviderMode } from "@/lib/stripe";
import { PaySimulator } from "./PaySimulator";

export const dynamic = "force-dynamic";

/**
 * Dev checkout simulator (R05-8).
 *
 * It exists for local flows where no Stripe keys are configured. With payments
 * configured it must not be reachable at all: the gate is server-side and 404s,
 * so a live deployment never serves a page that offers to "complete a stake"
 * without a provider behind it. The API it drives (/api/dev/pay) already
 * refuses to work outside dev mode; this closes the page itself.
 */
export default function DevPayPage({ params }: { params: { paymentId: string } }) {
  if (getProviderMode() !== "dev") notFound();
  return <PaySimulator paymentId={params.paymentId} />;
}