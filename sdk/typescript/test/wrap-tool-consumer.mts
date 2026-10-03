import { wrapTool, type WrapToolOptions, type ToolCallEffect } from '@once-agent/sdk';
type Input = { intent: string; body: string; traceId?: string };
type Args = { body: string };
type Receipt = { id: number; body: string };
const semantics: WrapToolOptions<Input, Args, Receipt> = {
  operationId: input => input.intent,
  effect: input => ({ tool: 'typed.account-A.send', args: { body: input.body } }),
  reconcile: ({ effect }) => ({ status: 'CONFIRMED', result: { id: 1, body: effect.args.body } }),
};
const run = wrapTool(async (args: Args): Promise<Receipt> => ({ id: 1, body: args.body }), semantics);
const receipt: Promise<Receipt> = run({ intent: '1', body: 'test' });
const effect: ToolCallEffect<Args> = semantics.effect({ intent: '1', body: 'test' });
// @ts-expect-error identity is required
wrapTool(async (args: Args) => args, { effect: () => effect });
// @ts-expect-error callback arguments must match declared effect args
wrapTool(async (args: { amount: number }) => args, semantics);
void receipt;
// Ordinary typed callbacks contextualize selectors without extra annotations.
const send = async (args: { orderId: string; message: string }) => args;
const protectedSend = wrapTool(send, {
  operationId: ({ orderId }) => `order:${orderId}:send`,
  effect: ({ orderId, message }) => ({ tool: 'typed.account-A.send', args: { orderId, message } }),
});
protectedSend({ orderId: 'order-1', message: 'synthetic' });
