import { Logger } from 'homebridge/lib/logger';
import { HKArmState, TCApi } from './tc';

let api = new TCApi(Logger.withPrefix(`TC`), {
  username: 'mhillman4',
  password: 'Darter-frontier-overcoat-queazy0',
});

const run = async () => {
  try {
    const state = await api.armSystem(HKArmState.DISARM);
    console.log(`got status`, state);
  } catch (err) {
    console.error(`[ERROR] ${err}`);
  }
}

run();
