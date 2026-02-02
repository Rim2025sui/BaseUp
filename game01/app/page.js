'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';

/**
 * FIXES:
 * - Attempts never goes above 7 (no "8/7")
 * - Leaderboard uses raw JSON-RPC eth_getLogs (no ENS / no getEnsAddress)
 * - Basename + avatar via Basenames L2 Resolver (no resolver(bytes32) -> no BAD_DATA)
 */

// === CONFIG ===
const CHAIN_ID = 8453;
const CHAIN_HEX = '0x2105';

const READ_RPC_URL = 'https://mainnet.base.org';

const CONTRACT_ADDRESS = '0x622678862992c0A2414b536Bc4B8B391602BCf';

// Basenames L2 Resolver (Base docs)
const BASENAME_L2_RESOLVER_ADDRESS = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';

// Leaderboard lookback (не 200k)
const LOOKBACK_BLOCKS = 80_000;

// max attempts
const MAX_ATTEMPTS = 7;

// fixed gas for write
const GAS_HEX = '0x249F0'; // 150000

// === ABI ===
const L2_RESOLVER_ABI = [
  'function name(bytes32 node) view returns (string)',
  'function text(bytes32 node, string key) view returns (string)',
];

const GAME_WRITE_ABI = [
  'function play(uint256 score, uint256 guess)',
  'function save(uint256 score, uint256 guess)',
  'function record(uint256 score, uint256 guess)',
  'function submit(uint256 score, uint256 guess)',
];

// event candidates (user is indexed!)
const EVENT_SIGS = [
  'Played(address,uint256,uint256,uint256)',
  'GamePlayed(address,uint256,uint256,uint256)',
];

// === utils ===
function shortAddr(a) {
  if (!a) return '';
  return a.slice(0, 6) + '…' + a.slice(-4);
}

function ipfsToHttp(url) {
  if (!url) return '';
  if (url.startsWith('ipfs://')) {
    const cid = url.replace('ipfs://', '');
    return `https://ipfs.io/ipfs/${cid}`;
  }
  return url;
}

function calcScore(attemptsUsed) {
  // 1..7 attempts -> score 7..1 (как у тебя было)
  // attemptsUsed=5 => score=3
  return Math.max(1, 8 - attemptsUsed);
}

function randomSecret() {
  return 60 + Math.floor(Math.random() * 61); // 60..120
}

function intToHex(n) {
  return '0x' + Number(n).toString(16);
}

async function rpc(method, params) {
  const res = await fetch(READ_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

export default function Page() {
  // READ provider for contract calls (no network name -> no ENS ops)
  const readProvider = useMemo(() => new ethers.JsonRpcProvider(READ_RPC_URL), []);
  const l2ResolverRead = useMemo(
    () => new ethers.Contract(BASENAME_L2_RESOLVER_ADDRESS, L2_RESOLVER_ABI, readProvider),
    [readProvider]
  );

  // wallet
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState(CHAIN_ID);

  // basename
  const [basename, setBasename] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [nameStatus, setNameStatus] = useState('');

  // game
  const [secret, setSecret] = useState(() => randomSecret());
  const [guess, setGuess] = useState('');
  const [hint, setHint] = useState('-');
  const [attempts, setAttempts] = useState(0);
  const [wins, setWins] = useState(0);
  const [rounds, setRounds] = useState(1);

  // scoring
  const [lastWin, setLastWin] = useState(null); // { guessK, score }
  const [bestScore, setBestScore] = useState(0);
  const [totalScore, setTotalScore] = useState(0);

  // tx/diag
  const [diag, setDiag] = useState('');
  const [err, setErr] = useState('');
  const [savedTx, setSavedTx] = useState('');

  // leaderboard
  const [leaderboard, setLeaderboard] = useState([]);
  const [lbStatus, setLbStatus] = useState('');

  // write method cache
  const [writeMethod, setWriteMethod] = useState('');

  // persist game state
  useEffect(() => {
    try {
      const raw = localStorage.getItem('baseup_state_v2');
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.secret === 'number') setSecret(s.secret);
      if (typeof s.attempts === 'number') setAttempts(s.attempts);
      if (typeof s.wins === 'number') setWins(s.wins);
      if (typeof s.rounds === 'number') setRounds(s.rounds);
      if (typeof s.bestScore === 'number') setBestScore(s.bestScore);
      if (typeof s.totalScore === 'number') setTotalScore(s.totalScore);
      if (s.lastWin) setLastWin(s.lastWin);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        'baseup_state_v2',
        JSON.stringify({ secret, attempts, wins, rounds, bestScore, totalScore, lastWin })
      );
    } catch {}
  }, [secret, attempts, wins, rounds, bestScore, totalScore, lastWin]);

  // wallet listeners
  useEffect(() => {
    (async () => {
      try {
        if (!window.ethereum) return;

        const bp = new ethers.BrowserProvider(window.ethereum);
        const net = await bp.getNetwork();
        setChainId(Number(net.chainId));

        const accs = await bp.listAccounts();
        if (accs?.length) {
          const a = await bp.getSigner().then((s) => s.getAddress());
          setAddress(a);
        }

        window.ethereum.on?.('accountsChanged', (accs2) => {
          const a2 = accs2?.[0] || '';
          setAddress(a2);
          setBasename('');
          setAvatarUrl('');
          setNameStatus('');
        });

        window.ethereum.on?.('chainChanged', (hex) => {
          const id = parseInt(hex, 16);
          setChainId(id);
        });
      } catch {}
    })();
  }, []);

  async function ensureWallet() {
    setErr('');
    setDiag('');
    if (!window.ethereum) throw new Error('Нет wallet provider (window.ethereum). Открой в Base App / кошельке.');

    const bp = new ethers.BrowserProvider(window.ethereum);
    await bp.send('eth_requestAccounts', []);

    const signer = await bp.getSigner();
    const a = await signer.getAddress();
    setAddress(a);

    const net = await bp.getNetwork();
    const cid = Number(net.chainId);
    setChainId(cid);

    if (cid !== CHAIN_ID) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_HEX }],
        });
        setChainId(CHAIN_ID);
      } catch {
        throw new Error('Переключи сеть на Base (8453) и повтори.');
      }
    }
    return signer;
  }

  // basename (no resolver(bytes32))
  async function refreshBasename() {
    setErr('');
    setNameStatus('Обновляю имя...');
    setBasename('');
    setAvatarUrl('');

    try {
      if (!address) {
        setNameStatus('Подключи кошелёк.');
        return;
      }

      const reverseName = `${address.slice(2).toLowerCase()}.addr.reverse`;
      const reverseNode = ethers.namehash(reverseName);

      const name = await l2ResolverRead.name(reverseNode);

      if (!name) {
        setNameStatus('Base Name не найден (reverse/primary record не выставлен).');
        return;
      }

      setBasename(name);

      try {
        const node = ethers.namehash(name);
        const avatar = await l2ResolverRead.text(node, 'avatar');
        const httpAvatar = ipfsToHttp(avatar);
        if (httpAvatar) setAvatarUrl(httpAvatar);
      } catch {}

      setNameStatus('Ок.');
    } catch (e) {
      setNameStatus('');
      setErr(`Имя/аватар: ${e?.message || String(e)}`);
    }
  }

  // game controls
  function newRound() {
    setErr('');
    setDiag('');
    setSavedTx('');
    setHint('-');
    setAttempts(0);
    setGuess('');
    setRounds((r) => r + 1);
    setSecret(randomSecret());
  }

  function checkGuess() {
    setErr('');
    setDiag('');
    setSavedTx('');

    // FIX: never allow attempts > 7
    if (attempts >= MAX_ATTEMPTS) {
      setHint('❌ Попытки закончились. Нажми "Новый раунд".');
      return;
    }

    const g = parseInt(guess, 10);
    if (!Number.isFinite(g)) {
      setHint('Введи число (2–3 цифры)');
      return;
    }

    const gg = Math.max(60, Math.min(120, g));
    const nextAttempts = attempts + 1;
    setAttempts(nextAttempts);

    if (gg === secret) {
      setHint('✅ Угадал!');
      const score = calcScore(nextAttempts);
      const guessK = gg * 1000;

      setWins((w) => w + 1);
      setBestScore((b) => Math.max(b, score));
      setTotalScore((t) => t + score);
      setLastWin({ guessK, score });

      return;
    }

    if (nextAttempts >= MAX_ATTEMPTS) {
      setHint(`❌ Попытки закончились. Было: ${secret}`);
      return;
    }

    setHint(gg < secret ? '⬆️ Больше' : '⬇️ Меньше');
  }

  async function detectWriteMethod(signer) {
    if (writeMethod) return writeMethod;

    const from = await signer.getAddress();
    const candidates = ['play', 'save', 'record', 'submit'];
    const iface = new ethers.Interface(GAME_WRITE_ABI);

    for (const fn of candidates) {
      try {
        const data = iface.encodeFunctionData(fn, [1, 1]);
        // call via READ provider (safe)
        await readProvider.call({ to: CONTRACT_ADDRESS, from, data });
        setWriteMethod(fn);
        return fn;
      } catch {}
    }
    throw new Error('Не нашёл метод записи (play/save/record/submit) в контракте.');
  }

  async function saveOnchain() {
    setErr('');
    setDiag('Диагностика: готовлю транзакцию...');
    setSavedTx('');

    try {
      if (!lastWin) throw new Error('Сначала выиграй раунд (нужна “Последняя победа”).');

      const signer = await ensureWallet();
      const fn = await detectWriteMethod(signer);

      const contract = new ethers.Contract(CONTRACT_ADDRESS, GAME_WRITE_ABI, signer);

      // send tx (score, guessK)
      setDiag('Диагностика: жду окно подписи...');
      const tx = await contract[fn](lastWin.score, lastWin.guessK, {
        gasLimit: BigInt(parseInt(GAS_HEX, 16)),
      });

      setSavedTx(tx.hash);
      setDiag(`Диагностика: TX отправлена: ${tx.hash}`);

      await fetchLeaderboard();
    } catch (e) {
      setDiag('');
      setErr(e?.message || String(e));
    }
  }

  // LEADERBOARD: raw RPC eth_getLogs (NO ENS)
  async function fetchLeaderboard() {
    setErr('');
    setLbStatus('Обновляю лидерборд...');

    try {
      const latestHex = await rpc('eth_blockNumber', []);
      const latest = parseInt(latestHex, 16);
      const fromBlock = Math.max(0, latest - LOOKBACK_BLOCKS);

      const topics0 = EVENT_SIGS.map((sig) => ethers.id(sig)); // keccak
      const logs = await rpc('eth_getLogs', [
        {
          address: CONTRACT_ADDRESS,
          fromBlock: intToHex(fromBlock),
          toBlock: 'latest',
          topics: [topics0],
        },
      ]);

      // decode: user is topics[1] (indexed), data has 3 uint256: score, guess, ts
      const coder = ethers.AbiCoder.defaultAbiCoder();
      const map = new Map();

      // limit processing to last N logs to keep UI fast
      const slice = logs.length > 600 ? logs.slice(logs.length - 600) : logs;

      for (const l of slice) {
        if (!l?.topics?.[1]) continue;

        const user = ('0x' + l.topics[1].slice(26)).toLowerCase();
        const decoded = coder.decode(['uint256', 'uint256', 'uint256'], l.data);
        const score = Number(decoded[0]);

        if (!map.has(user)) map.set(user, { user, total: 0, best: 0, lastTx: l.transactionHash });
        const row = map.get(user);

        row.total += score;
        row.best = Math.max(row.best, score);
        row.lastTx = l.transactionHash;
      }

      const top = Array.from(map.values())
        .sort((a, b) => (b.total - a.total) || (b.best - a.best))
        .slice(0, 10);

      setLeaderboard(top);
      setLbStatus(`Ок. Событий в lookback: ${logs.length}`);
    } catch (e) {
      setLeaderboard([]);
      setLbStatus('');
      setErr(`Лидерборд: ${e?.message || String(e)}`);
    }
  }

  // initial load
  useEffect(() => {
    fetchLeaderboard().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (address) refreshBasename().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
      <h1 style={{ fontSize: 28, marginBottom: 10 }}>BaseUp — Guess BTC (k)</h1>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: 14, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{address ? shortAddr(address) : 'Кошелёк не подключен'}</div>
            <div style={{ color: '#6b7280', marginTop: 4 }}>
              ChainId: <b>{chainId}</b> <br />
              Контракт: <b>{CONTRACT_ADDRESS}</b>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 700, color: '#111827' }}>Base Name:</div>
              <div style={{ color: basename ? '#111827' : '#b91c1c', marginTop: 2 }}>
                {basename ? basename : 'не найден (скорее всего не выставлен reverse/primary record).'}
              </div>

              {avatarUrl ? (
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <img src={avatarUrl} alt="avatar" width={44} height={44} style={{ borderRadius: 12, border: '1px solid #e5e7eb' }} />
                  <span style={{ color: '#6b7280', fontSize: 13 }}>avatar (text record)</span>
                </div>
              ) : null}

              <div style={{ marginTop: 8, color: '#6b7280', fontSize: 13 }}>{nameStatus}</div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={refreshBasename} style={btnStyle}>Обновить Base Name</button>
            <button onClick={newRound} style={btnStyle}>Новый раунд</button>
            <button onClick={saveOnchain} style={{ ...btnStyle, fontWeight: 800 }}>Сохранить результат (onchain)</button>
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: 14, marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, margin: 0, marginBottom: 10 }}>Угадай уровень BTC (k): введи 60…120</h2>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            value={guess}
            onChange={(e) => setGuess(e.target.value)}
            placeholder="например 69"
            inputMode="numeric"
            style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #e5e7eb', fontSize: 16, width: 180 }}
          />
          <button onClick={checkGuess} style={btnStyle}>Проверить</button>
          <div style={{ color: '#6b7280' }}>Введите число (2–3 цифры)</div>
        </div>

        <div style={{ marginTop: 12, fontSize: 18 }}>
          <b>Подсказка:</b> {hint}
        </div>

        <div style={{ marginTop: 10, color: '#111827' }}>
          Попыток (в этом раунде): <b>{Math.min(attempts, MAX_ATTEMPTS)}</b> / {MAX_ATTEMPTS} <br />
          Раунды: <b>{rounds}</b> <br />
          Победы: <b>{wins}</b> <br />
          Лучший результат за раунд: <b>{bestScore}</b> <br />
          Суммарные очки (total): <b>{totalScore}</b>
        </div>

        <div style={{ marginTop: 12, padding: 12, borderRadius: 14, background: '#f9fafb', border: '1px solid #e5e7eb' }}>
          <b>Последняя победа (для onchain):</b>
          <div style={{ marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' }}>
            guess: <b>{lastWin ? `${Math.floor(lastWin.guessK / 1000)}k` : '-'}</b> <br />
            score: <b>{lastWin ? lastWin.score : '-'}</b> <br />
            saved tx: <b>{savedTx ? savedTx : '-'}</b>
          </div>
        </div>

        {diag ? <div style={{ marginTop: 12, color: '#047857', fontWeight: 700 }}>{diag}</div> : null}
        {err ? <div style={{ marginTop: 12, color: '#b91c1c', fontWeight: 800 }}>Ошибка: {err}</div> : null}
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 14, padding: 14 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Leaderboard (top-10, sum score)</h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button onClick={fetchLeaderboard} style={btnStyle}>Обновить лидерборд</button>
            <span style={{ color: '#6b7280', fontSize: 13 }}>{lbStatus}</span>
          </div>
        </div>

        <div style={{ marginTop: 12, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Address</th>
                <th style={th}>Total</th>
                <th style={th}>Best</th>
                <th style={th}>Last Tx</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 12, color: '#6b7280' }}>
                    Нет данных (или событий нет в lookback).
                  </td>
                </tr>
              ) : (
                leaderboard.map((r, i) => (
                  <tr key={r.user}>
                    <td style={td}>{i + 1}</td>
                    <td style={td}>{shortAddr(r.user)}</td>
                    <td style={td}>{r.total}</td>
                    <td style={td}>{r.best}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12 }}>
                      {r.lastTx ? shortAddr(r.lastTx) : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 10, color: '#6b7280', fontSize: 12 }}>
          Лидерборд берётся из логов за последние {LOOKBACK_BLOCKS.toLocaleString()} блоков (без ENS).
        </div>
      </div>
    </main>
  );
}

const btnStyle = {
  padding: '10px 12px',
  borderRadius: 12,
  border: '1px solid #e5e7eb',
  background: 'white',
  cursor: 'pointer',
};

const th = {
  textAlign: 'left',
  padding: '10px 8px',
  borderBottom: '1px solid #e5e7eb',
  color: '#374151',
  fontSize: 13,
};

const td = {
  padding: '10px 8px',
  borderBottom: '1px solid #f3f4f6',
  fontSize: 14,
};
