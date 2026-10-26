import { fetchFundingStatus, fetchStatus, requestFunds } from './chain.js';

export function watchFunding(player, config, update, funded) {
  update({ funding: false, balance: null });
  let stopped = false;
  let busy = false;
  if (!config || !player) return () => {};
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const info = await fetchFundingStatus(player, config);
      if (stopped) return;
      update({ balance: info.balance });
      if (info.needsFunds && !config.accountFunding) {
        update({ funding: true });
        try {
          await requestFunds(config, player);
          if (!stopped) funded();
        } finally {
          if (!stopped) update({ funding: false });
        }
      }
      const status = await fetchStatus(config);
      if (!stopped) update({ status });
    } catch {
      /* Retry transient gateway/faucet failures on the next poll. */
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(tick, 2500);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
