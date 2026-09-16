# Responsive screens, persistent webhook and Spot sizing

- Grid columns and tables shrink to the viewport at 100% browser zoom. Long forms and logs scroll vertically; small-screen Trade Log rows stack as cards. Full execution fields remain in each row's Details / Notes disclosure.
- Recent signals show their received timestamp in the browser's local timezone; the timestamp tooltip provides ISO UTC.
- Rejected rows include an immediately visible EN/TH explanation and the original error. Original rejected orders are never silently retried or changed to filled.
- Prices use up to 10 significant digits, preserving small token prices and stop-loss differences.
- Webhooks remain hash-verified on intake. Schema 5 additionally stores the current secret encrypted with AES-256-GCM and owner-specific authenticated context. Only the signed-in owner can retrieve its URL from a no-store API.
- Existing hash-only URLs are recovered on the next authenticated webhook request, or by pasting the original URL into the owner's account page. No URL rotation is necessary. A hash cannot be reversed.
- New defaults and the explicitly updated owner profile use Max order notional 10,000 and Max daily notional 100,000. Binance Global values are USDT; USD is an accepted symbol alias, not an exchange-rate conversion.
- Both limits are editable in Risk manager. Percent Equity automatic sizing is enabled: quantity is reduced to the lowest of the risk-derived size, free configured equity after committed/reserved capital, order cap, and remaining daily budget. The adjustment is recorded in the broker-response log.
- Explicit quantity/fixed-notional requests are still rejected if oversized. Stop-loss, news, volatility, symbol allowlist, daily loss, and all other protections remain enforced.
- The owner requested these limits and automatic sizing. The operator script updates only those three fields and audits the change; it does not expand the symbol allowlist or alter equity.
- Observed rejection causes included oversized Percent Equity BUY orders, exit signals with no filled entry, and LUNCUSDT missing from the allowlist. TradingView's local in-position flag is not an execution acknowledgement; an exit can legitimately be rejected after a failed BUY.
- Trading stays Paper-only. Configured equity is a simulation snapshot, not a live broker balance.
