import { notFound } from "next/navigation";
import { PaymentProvider } from "@prisma/client";
import { devSimulatorEnabled, getProviderMode } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { PaySimulator } from "./PaySimulator";

export const dynamic = "force-dynamic";

/**
 * Dev checkout simulator (R05-8, R07-1, R07-2, R07-6).
 *
 * It exists for local flows where no Stripe keys are configured. With payments
 * configured it must not be reachable at all: the gate is server-side and 404s,
 * so a live deployment never serves a page that offers to "complete a stake"
 * without a provider behind it.
 *
 * Three gates, all server-side, all 404 (a 404 says "no such page", which is true
 * for everyone who should not be here):
 *   1. the provider mode, so a Stripe-configured deployment never serves it;
 *   2. devSimulatorEnabled(), because mode alone is not an environment — a
 *      production box with a missing Stripe secret read as 'dev' and served this
 *      page, and a preview deployment sharing the production database served it
 *      while writing real rows (R07-1, R07-2);
 *   3. the payment row's own provider. The page can only drive the dev
 *      simulator, so a legacy WHOP row must not render a button whose every
 *      press is a 403 (R07-6).
 */
export default async function DevPayPage({ params }: { params: { paymentId: string } }) {
  if (getProviderMode() !== "dev") notFound();
  if (!devSimulatorEnabled()) notFound();
  const payment = await prisma.payment.findUnique({
    where: { id: params.paymentId },
    select: { provider: true },
  });
  if (payment?.provider !== PaymentProvider.DEV) notFound();
  return <PaySimulator paymentId={params.paymentId} />;
}
