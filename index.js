import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  defineChain, createPublicClient, createWalletClient, http,
  formatEther, parseEther, parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_L1 = "https://ethereum-sepolia-rpc.publicnode.com";
const RPC_L2 = "https://sepolia-rpc.giwa.io";

if (!PRIVATE_KEY) {
  console.error('Please set PRIVATE_KEY in your .env file');
  process.exit(1);
}
const account = privateKeyToAccount(PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);

const giwaSepolia = defineChain({
  id: 91342,
  name: 'Giwa Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_L2] } },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
    l1StandardBridge: { [sepolia.id]: { address: '0x77b2ffc0F57598cAe1DB76cb398059cF5d10A7E7' } },
  },
  testnet: true,
});

const publicClientL1 = createPublicClient({ chain: sepolia, transport: http(RPC_L1) });
const walletClientL1 = createWalletClient({ account, chain: sepolia, transport: http(RPC_L1) });
const publicClientL2 = createPublicClient({ chain: giwaSepolia, transport: http(RPC_L2) });

const L1_STANDARD_BRIDGE_ABI = parseAbi([
  'function depositETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable'
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isValidAmount(v) { try { parseEther(v); return true; } catch { return false; } }

async function sanityCheckRpcs() {
  const [idL1, idL2] = await Promise.all([publicClientL1.getChainId(), publicClientL2.getChainId()]);
  if (idL1 !== sepolia.id) throw new Error(`L1 RPC is not Sepolia (id=${idL1})`);
  if (idL2 !== giwaSepolia.id) throw new Error(`L2 RPC is not Giwa Sepolia (id=${idL2})`);
}

async function showInitialBalances() {
  const [l1, l2] = await Promise.all([
    publicClientL1.getBalance({ address: account.address }),
    publicClientL2.getBalance({ address: account.address }),
  ]);
  console.log('\n=== BALANCES ===');
  console.log(`Sepolia (L1):      ${formatEther(l1)} ETH`);
  console.log(`Giwa Sepolia (L2): ${formatEther(l2)} ETH`);
  console.log('=================\n');
}

function startSpinner(text) {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  return setInterval(() => {
    process.stdout.write('\r' + frames[i = ++i % frames.length] + ' ' + text);
  }, 100);
}

function stopSpinner(spinnerId, message) {
  clearInterval(spinnerId);
  process.stdout.write('\r'.padEnd(50, ' ') + '\r');
  if (message) console.log(message);
}

async function waitForL2Credit(prevBalance, increaseWei, { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const target = prevBalance + increaseWei;
  while (Date.now() < deadline) {
    const now = await publicClientL2.getBalance({ address: account.address });
    if (now >= target) return now;
    await sleep(intervalMs);
  }
  throw new Error('Timeout: L2 balance did not increase. Check explorer/RPC.');
}

async function depositEth(amount) {
  const beforeL2 = await publicClientL2.getBalance({ address: account.address });
  const wei = parseEther(amount);

  console.log(`\nDeposit ${amount} ETH: Sepolia -> Giwa ...`);
  const bridge = giwaSepolia.contracts.l1StandardBridge[sepolia.id].address;
  const minGasLimit = 200_000;
  const hash = await walletClientL1.writeContract({
    address: bridge,
    abi: L1_STANDARD_BRIDGE_ABI,
    functionName: 'depositETHTo',
    args: [account.address, minGasLimit, '0x'],
    value: wei,
  });
  console.log(`L1 bridge tx : ${hash} (waiting for confirmation...)`);

  const animL1 = startSpinner('Waiting for L1 confirmation...');
  const rec = await publicClientL1.waitForTransactionReceipt({ hash });
  stopSpinner(animL1, '✔️ L1 tx confirmed!');

  if (rec.status !== 'success') throw new Error('depositETHTo reverted on L1.');

  console.log('Waiting for L2 balance increase...');
  const animL2 = startSpinner('Monitoring L2 balance...');
  const afterL2 = await waitForL2Credit(beforeL2, wei);
  stopSpinner(animL2, '✔️ L2 balance increased!');

  console.log('\nDeposit completed!');
  console.log(`Giwa Sepolia (L2) Balance: ${formatEther(afterL2)} ETH\n`);
}

async function main() {
  try {
    await sanityCheckRpcs();
    await showInitialBalances();

    const rl = readline.createInterface({ input, output });
    const amount = (await rl.question('Enter deposit amount in ETH (e.g., 0.05): ')).trim();
    rl.close();

    if (!isValidAmount(amount)) {
      console.log('Invalid amount.');
      process.exit(1);
    }

    await depositEth(amount);
  } catch (e) {
    console.error(e?.message || e);
    process.exit(1);
  }
}

main();
