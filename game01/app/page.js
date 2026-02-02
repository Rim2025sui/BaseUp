'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';

/**
 * ВАЖНО:
 * 1) Пишем транзы через BrowserProvider (wallet)
 * 2) Читаем basename + логи через JsonRpcProvider (публичный RPC) — стабильно, без BAD_DATA
 */

// === НАСТРОЙКИ ===
const CHAIN_ID = 8453;
const CONTRACT_ADDRESS = '0x622678862992c0A2414b536Bc4B8B391602BCf';

// Basenames L2 Resolver (из Base docs / гайда)
const BASENAME_L2_RESOLVER_ADDRESS = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD';

// Публичный RPC (для чтения/логов)
const READ_RPC_URL = 'https://mainnet.base.org';

// Сколько блоков назад читать лидерборд (чтобы не упираться в лимиты)
const LOOKBACK_BLOCKS = 80_000; // ~несколько дней на Base

// === ABI (минимально нужное) ===
// 1) L2 Resolver: name(bytes32) + text(bytes32,string)
const L2_RESOLVER_ABI = [
  'function name(bytes32 node) view returns (string)',
  'function text(bytes32 node, string key) view returns (string)',
];

// 2) Контракт игры: мы не знаем точное имя функции (ты мог менять),
// поэтому: поддержим несколько вариантов и выберем рабочий через eth_call.
const GAME_WRITE_ABI = [
  'function play(uint256 score, uint256 guess)',
  'function save(uint256 score, uint256 guess)',
  'function record(uint256 score, uint256 guess)',
  'function submit(uint256 score, uint256 guess)',
];

// События (поддержим 2 имени — на всякий)
const EVENT_SIGS = [
  'Played(address,uint256,uint256,uint256)',
  'GamePlayed(address,uint256,uint256,uint256)',
];

// === УТИЛИТЫ ===
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
  // У тебя на скрине: попыток 5/7 => score 3
  // 8 - 5 = 3
  return Math.max(1, 8 - attemptsUsed);
}

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export default function Page() {
  // providers
  const readProvider = useMemo(() => new ethers.JsonRpcProvider(READ_RPC_URL, { chainId: CHAIN_ID, name: 'base' }), []);
  const l2ResolverRead = useMemo(() => new ethers.Contract(BASENAME_L2_RESOLVER_ADDRESS, L2_RESOLVER_ABI, readProvider), [readProvider]);

  // wallet state
  const [address, setAddress] = useState('');
  const [chainId, setChainId] = useState(CHAIN_ID);

  // basename state
  const [basename, setBasename] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [nameStatus, setNameStatus] = useState('');

  // game state
  const [secret, setSecret] = useState(() => 60 + Math.floor(Math.random() * 61)); // 60..120
  const [guess, setGuess] = useState('');
  const [hint, setHint] = useState('-');
  const [attempts, setAttempts] = useState(0);
  const [wins, setWins] = useState(0);
  const [rounds, setRounds] = useState(1);

  // scoring state
  const [lastWin, setLastWin] = useState(null); // { guessK, score }
  const [bestScore, setBestScore] = useState(0);
  const [totalScore, setTotalScore] = useState(0);

  // tx/diagnostics
  const [diag, setDiag] = useState('');
  const [err, setErr] = useState('');
  const [savedTx, setSavedTx] = useState('');

  // leaderboard
  const [leaderboard, setLeaderboard] = useState([]);
  const [lbStatus, setLbStatus] = useState('');

  // выбранный метод записи (play/save/record/submit)
  const [writeMethod, setWriteMethod] = useState('');

  // === LOAD/STORE localStorage (чтобы не терялось) ===
  useEffect(() => {
    try {
      const raw = localStorage.getItem('baseup_state_v1');
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
        'baseup_state_v1',
        JSON.stringify({ secret, attempts, wins, rounds, bestScore, totalScore, lastWin })
      );
    } catch {}
  }, [secret, attempts, wins, rounds, bestScore, totalScore, lastWin]);

  // === Wallet connect (лениво, без лишних кнопок) ===
  useEffect(() => {
    (async () => {
      try {
        if (typeof window === 'undefined') return;
        if (!window.ethereum) return;

        const bp = new ethers.BrowserProvider(window.ethereum);
        const net = await bp.getNetwork();
        setChainId(Number(net.chainId));

        const accs = await bp.listAccounts();
        if (accs && accs.length) {
          const a = await bp.getSigner().then((s) => s.getAddress());
          setAddress(a);
        }

        // подписки
        window.ethereum.on?.('accountsChanged', (accs2) => {
          const a2 = (accs2 && accs2[0]) ? accs2[0] : '';
          setAddress(a2);
          setBasename('');
          setAvatarUrl('');
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

    // request accounts
    await bp.send('eth_requestAccounts', []);
    const signer = await bp.getSigner();
    const a = await signer.getAddress();
    setAddress(a);

    // chain check
    const net = await bp.getNetwork();
    const cid = Number(net.chainId);
    setChainId(cid);

    if (cid !== CHAIN_ID) {
      // попросим переключиться
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: '0x2105' }], // 8453
        });
        setChainId(CHAIN_ID);
      } catch (e) {
        throw new Error('Переключи сеть на Base (8453), потом снова жми Save onchain.');
      }
    }

    return signer;
  }

  // === Basename resolve (БЕЗ resolver(bytes32)) ===
  async function refreshBasename() {
    setErr('');
    setNameStatus('Обновляю имя...');
    setBasename('');
    setAvatarUrl('');

    try {
      if (!address) {
        setNameStatus('Подключи кошелёк (нажми Save onchain — он сам запросит подключение).');
        return;
      }

      // стандартный ENS reverse: <addr>.addr.reverse
      const reverseName = `${address.slice(2).toLowerCase()}.addr.reverse`;
      const reverseNode = ethers.namehash(reverseName);

      const name = await l2ResolverRead.name(reverseNode);
      if (!name) {
        setBasename('');
        setAvatarUrl('');
        setNameStatus('Base Name не найден (reverse/primary record не выставлен).');
        return;
      }

      setBasename(name);

      // avatar через text record "avatar"
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

  // === ИГРА ===
  function newRound() {
    setErr('');
    setDiag('');
    setSavedTx('');
    setHint('-');
    setAttempts(0);
    setGuess('');
    setRounds((r) => r + 1);
    setSecret(60 + Math.floor(Math.random() * 61));
  }

  function checkGuess() {
    setErr('');
    setDiag('');
    setSavedTx('');

    const g = parseInt(guess, 10);
    if (!Number.isFinite(g)) {
      setHint('Введи число (2–3 цифры)');
      return;
    }
    const gg = clampInt(g, 60, 120);

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

    if (nextAttempts >= 7) {
      setHint(`❌ Не угадал. Было: ${secret}`);
      return;
    }

    setHint(gg < secret ? '⬆️ Больше' : '⬇️ Меньше');
  }

  // === Автовыбор метода записи (play/save/record/submit) ===
  async function detectWriteMethod(signer) {
    if (writeMethod) return writeMethod;

    const from = await signer.getAddress();
    const candidates = ['play', 'save', 'record', 'submit'];
    const iface = new ethers.Interface(GAME_WRITE_ABI);

    // пробуем eth_call на каждом селекторе
    for (const fn of candidates) {
      try {
        const data = iface.encodeFunctionData(fn, [1, 1]); // тестовые аргументы
        await readProvider.call({ to: CONTRACT_ADDRESS, from, data });
        setWriteMethod(fn);
        return fn;
      } catch {
        // не этот
      }
    }
    throw new Error('Не нашёл метод записи в контракте (play/save/record/submit).');
  }

  // === SAVE ONCHAIN ===
  async function saveOnchain() {
    setErr('');
    setDiag('Диагностика: готовлю транзакцию...');
    setSavedTx('');

    try {
      if (!lastWin) {
        throw new Error('Сначала выиграй раунд (нужна “Последняя победа”).');
      }

      const signer = await ensureWallet();

      // метод
      const fn = await detectWriteMethod(signer);

      const contract = new ethers.Contract(CONTRACT_ADDRESS, GAME_WRITE_ABI, signer);

      // важно: guessK и score
      const tx = await contract[fn](lastWin.score, lastWin.guessK);
      setSavedTx(tx.hash);
      setDiag(`Диагностика: TX отправлена: ${tx.hash}`);

      // обновим лидерборд
      await fetchLeaderboard();
    } catch (e) {
      setDiag('');
      setErr(e?.message || String(e));
    }
  }

  // === LEADERBOARD (из логов) ===
  async function fetchLeaderboard() {
    setLbStatus('Обновляю лидерборд...');
    try {
      const latest = await readProvider.getBlockNumber();
      const fromBlock = Math.max(0, latest - LOOKBACK_BLOCKS);

      const topics = EVENT_SIGS.map((sig) => ethers.id(sig));

      const logs = await readProvider.getLogs({
        address: CONTRACT_ADDRESS,
        fromBlock,
        toBlock: 'latest',
        topics: [topics],
      });

      // декодим одинаково (address,uint256,uint256,uint256)
      const coder = ethers.AbiCoder.defaultAbiCoder();

      const rows = logs
        .slice(-300) // ограничим, чтобы UI не умирал
        .map((l) => {
          const decoded = coder.decode(['address', 'uint256', 'uint256', 'uint256'], l.data);
          return {
            user: decoded[0],
            score: Number(decoded[1]),
            guess: Number(decoded[2]),
            ts: Number(decoded[3]),
            tx: l.transactionHash,
            block: Number(l.blockNumber),
          };
        })
        .sort((a, b) => b.block - a.block);

      // агрегируем топ-10 по суммарному score
      const map = new Map();
      for (const r of rows) {
        const key = r.user.toLowerCase();
        const prev = map.get(key) || { user: r.user, total: 0, best: 0, lastTx: r.tx };
        prev.total += r.score;
        prev.best = Math.max(prev.best, r.score);
        prev.lastTx = r.tx;
        map.set(key, prev);
      }

      const top = Array.from(map.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);

      setLeaderboard(top);
      setLbStatus(`Ок. Событий за lookback: ${logs.length}`);
    } catch (e) {
      setLeaderboard([]);
      setLbStatus('');
      setErr(`Лидерборд: ${e?.message || String(e)}`);
    }
  }

  useEffect(() => {
    // на старте подтянуть лидерборд
    fetchLeaderboard().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // при смене адреса — обновить basename
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
            <button onClick={refreshBasename} style={btnStyle}>
              Обновить Base Name
            </button>
            <button onClick={newRound} style={btnStyle}>
              Новый раунд
            </button>
            <button onClick={saveOnchain} style={{ ...btnStyle, fontWeight: 800 }}>
              Сохранить результат (onchain)
            </button>
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
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #e5e7eb',
              fontSize: 16,
              width: 180,
            }}
          />
          <button onClick={checkGuess} style={btnStyle}>
            Проверить
          </button>
          <div style={{ color: '#6b7280' }}>Введите число (2–3 цифры)</div>
        </div>

        <div style={{ marginTop: 12, fontSize: 18 }}>
          <b>Подсказка:</b> {hint}
        </div>

        <div style={{ marginTop: 10, color: '#111827' }}>
          Попыток (в этом раунде): <b>{attempts}</b> / 7 <br />
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
            <button onClick={fetchLeaderboard} style={btnStyle}>
              Обновить лидерборд
            </button>
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
          Примечание: лидерборд берётся из событий контракта за последние {LOOKBACK_BLOCKS.toLocaleString()} блоков (чтобы не упираться в лимиты RPC).
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
