// app/api/leaderboard/route.js
import { NextResponse } from "next/server";
import { ethers } from "ethers";

const CHAIN_ID = 8453;
const LOG_CHUNK = 10_000;

// ВАЖНО: событие у тебя называется Played (НЕ GamePlayed)
const ABI = [
  "event Played(address indexed user, uint256 score, uint256 guess, uint256 ts)",
];

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Number(searchParams.get("limit") || 10), 50);

    const RPC_URL =
      process.env.RPC_URL ||
      process.env.NEXT_PUBLIC_RPC_URL ||
      "https://1rpc.io/base";

    const CONTRACT_ADDRESS_RAW =
      process.env.CONTRACT_ADDRESS ||
      process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ||
      "0x085439394e6FEac14FFB61134ba8F81fA8A9f314";

    const CONTRACT_ADDRESS = ethers.getAddress(CONTRACT_ADDRESS_RAW);

    const deployBlockEnv = Number(process.env.DEPLOY_BLOCK || "0");
    const lookback = Number(process.env.LEADERBOARD_BLOCK_RANGE || "200000");

    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
    const latest = await provider.getBlockNumber();

    const fromBlock =
      deployBlockEnv > 0 && deployBlockEnv <= latest
        ? deployBlockEnv
        : Math.max(0, latest - lookback);

    const toBlock = latest;

    // проверка контракта
    const code = await provider.getCode(CONTRACT_ADDRESS);
    if (!code || code === "0x") {
      return NextResponse.json({
        ok: false,
        error: `No contract at ${CONTRACT_ADDRESS}`,
        meta: { rpc: RPC_URL, fromBlock, toBlock },
      });
    }

    const iface = new ethers.Interface(ABI);
    const topic0 = iface.getEvent("Played").topicHash;

    const allLogs = [];
    for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
      const end = Math.min(start + LOG_CHUNK - 1, toBlock);

      const logs = await provider.getLogs({
        address: CONTRACT_ADDRESS,
        fromBlock: start,
        toBlock: end,
        topics: [topic0],
      });

      if (logs?.length) allLogs.push(...logs);
    }

    // best score per user
    const best = new Map();
    for (const log of allLogs) {
      try {
        const p = iface.parseLog(log);
        const user = String(p.args.user).toLowerCase();
        const score = Number(p.args.score);
        const guess = Number(p.args.guess);
        const ts = Number(p.args.ts);

        const prev = best.get(user);
        if (!prev || score > prev.score || (score === prev.score && ts > prev.ts)) {
          best.set(user, {
            user,
            score,
            guessK: guess,
            ts,
            tx: log.transactionHash,
            blockNumber: log.blockNumber,
          });
        }
      } catch {}
    }

    const rows = Array.from(best.values())
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, limit);

    return NextResponse.json({
      ok: true,
      rows,
      meta: {
        rpc: RPC_URL,
        contract: CONTRACT_ADDRESS,
        fromBlock,
        toBlock,
        chunk: LOG_CHUNK,
        logsCount: allLogs.length,
        usersCount: best.size,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
