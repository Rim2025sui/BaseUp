'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { sdk } from '@farcaster/frame-sdk';

// === SETTINGS ===
const MIN_K = 60;
const MAX_K = 120;
const MAX_ATTEMPTS = 7;

// === FIXED BASE MAINNET ===
const BASE_MAINNET = {
  chainIdDec: 8453,
  chainIdHex: '0x2105',
  chainName: 'Base Mainnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
};

const ACTIVE = BASE_MAINNET;

// ✅ адрес берём из .env.local, иначе fallback (твой рабочий контракт со скрина)
const CONTRACT_ADDRESS =
  process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || '0x085439394e6FEac14FFB61134ba8F81fA8A9f314';

const CONTRACT_ABI = [
  'function played(uint256 score, uint256 guess) external',
  'event Played(address indexed user, uint256 score, uint256 guess, uint256 ts)',
];

// ТВОЙ basename (используем ТОЛЬКО как fallback, и только если forward-resolve == твой addr)
const KNOWN_BASENAME = 'rimbasenamber1.base.eth';

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatError(e) {
  try {
    const parts = [];
    if (e?.shortMessage) parts.push(`short=${e.shortMessage}`);
    if (e?.message) parts.push(`msg=${e.message}`);
    if (e?.code) parts.push(`code=${e.code}`);
    if (e?.reason) parts.push(`reason=${e.reason}`);
    if (e?.data) {
      const d = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      parts.push(`data=${d}`);
    }
    return parts.length ? parts.join(' | ') : String(e);
  } catch {
    return String(e?.message || e);
  }
}

// --- PROFILE HELPERS ---
function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-';
}

// Лёгкий blockies-аватар без зависимостей (canvas→dataURL)
function addrToAvatar(address, size = 6, scale = 8) {
  if (!address) return null;

  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = (seed * 31 + address.charCodeAt(i)) >>> 0;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

  const canvas = document.createElement('canvas');
  const N = size * scale;
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const baseHue = Math.floor(rand() * 360);
  const fg = `hsl(${baseHue},70%,45%)`;
  const bg = `hsl(${(baseHue + 180) % 360},60%,92%)`;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, N, N);

  ctx.fillStyle = fg;
  const cells = 5;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < Math.ceil(cells / 2); x++) {
      const on = rand() > 0.5;
      if (on) {
        ctx.fillRect(x * scale, y * scale, scale, scale);
        ctx.fillRect((cells - 1 - x) * scale, y * scale, scale, scale);
      }
    }
  }

  return canvas.toDataURL('image/png');
}

export default function Page() {
  // wallet
  const [hasProvider, setHasProvider] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [addr, setAddr] = useState('');
  const [chainId, setChainId] = useState(null);
  const [status, setStatus] = useState('Не подключено');

  // profile (avatar + display name)
  const [profileName, setProfileName] = useState('-');
  const [profileAvatar, setProfileAvatar] = useState(null);
  const [baseNameNote, setBaseNameNote] = useState(''); // пояснение почему не найдено

  // game
  const [targetK, setTargetK] = useState(() => randomInt(MIN_K, MAX_K));
  const [inputRaw, setInputRaw] = useState('');
  const [hint, setHint] = useState('');
  const [attemptsThisRound, setAttemptsThisRound] = useState(0);
  const [rounds, setRounds] = useState(0);
  const [wins, setWins] = useState(0);

  // score
  const [totalScore, setTotalScore] = useState(0);
  const [lastRoundScore, setLastRoundScore] = useState(0);
  const [bestRoundScore, setBestRoundScore] = useState(0);

  // last win persists
  const [lastWin, setLastWin] = useState(null); // { score, guessK, ts }
  const [lastSavedTx, setLastSavedTx] = useState('');

  // onchain ui
  const [isSaving, setIsSaving] = useState(false);
  const [txHash, setTxHash] = useState('');
  const [txMsg, setTxMsg] = useState('');
  const [err, setErr] = useState('');

  // leaderboard
  const [lbLoading, setLbLoading] = useState(false);
  const [lbRows, setLbRows] = useState([]);
  const [lbInfo, setLbInfo] = useState('');

  const isCorrectChain = chainId === ACTIVE.chainIdDec;

  const interpretedK = useMemo(() => {
    if (inputRaw.trim() === '') return null;
    if (!/^\d+$/.test(inputRaw)) return null;
    if (inputRaw.length > 3) return null;
    const n = Number(inputRaw);
    if (!Number.isFinite(n)) return null;
    return n;
  }, [inputRaw]);

  const interpretedLabel = useMemo(() => {
    if (interpretedK === null) return '';
    return `${interpretedK}k`;
  }, [interpretedK]);

  const interpretedUsd = useMemo(() => {
    if (interpretedK === null) return null;
    return interpretedK * 1000;
  }, [interpretedK]);

  function resetRound() {
    setTargetK(randomInt(MIN_K, MAX_K));
    setAttemptsThisRound(0);
    setInputRaw('');
    setHint('');
    setLastRoundScore(0);
    setErr('');
    setTxMsg('');
    setTxHash('');
  }

  function onInputChange(e) {
    const v = String(e.target.value || '').replace(/[^\d]/g, '').slice(0, 3);
    setInputRaw(v);
  }

  function validateRangeK(k) {
    if (k === null) return 'Введите число.';
    if (!Number.isInteger(k)) return 'Только целые числа.';
    if (k < MIN_K || k > MAX_K) return `Только от ${MIN_K} до ${MAX_K}.`;
    return '';
  }

  // ===== Profile resolve =====
  async function resolveBaseName(eth, address) {
    // Всегда даём аватар от адреса (без внешних источников)
    try {
      setProfileAvatar(addrToAvatar(address));
    } catch {
      setProfileAvatar(null);
    }

    setBaseNameNote('');
    setProfileName(shortAddr(address));

    try {
      const provider = new ethers.BrowserProvider(eth);

      // 1) reverse lookup (если выставлен)
      let name = null;
      try {
        name = await provider.lookupAddress(address);
      } catch {
        name = null;
      }

      if (name) {
        setProfileName(name);
        setBaseNameNote('');
        return;
      }

      // 2) fallback: проверяем ТВОЁ known имя через forward-resolve
      // и используем его ТОЛЬКО если оно реально указывает на этот адрес
      try {
        const resolved = await provider.resolveName(KNOWN_BASENAME);
        if (resolved && resolved.toLowerCase() === address.toLowerCase()) {
          setProfileName(KNOWN_BASENAME);
          setBaseNameNote('reverse не выставлен (показываю имя по forward-resolve)');
          return;
        }
      } catch {
        // ignore
      }

      setProfileName('не найден');
      setBaseNameNote('скорее всего reverse (Primary) не выставлен, поэтому lookupAddress вернул null');
    } catch {
      setProfileName(shortAddr(address));
      setBaseNameNote('не удалось сделать lookup');
    }
  }

  // ===== Wallet helpers =====
  async function refreshWalletState() {
    try {
      const eth = window.ethereum;
      if (!eth) return;

      const accounts = await eth.request({ method: 'eth_accounts' });
      const connected = Array.isArray(accounts) && accounts.length > 0;
      setIsConnected(connected);

      const cidHex = await eth.request({ method: 'eth_chainId' });
      setChainId(parseInt(cidHex, 16));

      if (connected) {
        const a = accounts[0];
        setAddr(a);
        setStatus('Подключено');

        // имя + аватар
        await resolveBaseName(eth, a);
      } else {
        setAddr('');
        setStatus('Не подключено');
        setProfileName('-');
        setProfileAvatar(null);
        setBaseNameNote('');
      }
    } catch (e) {
      setErr(formatError(e));
    }
  }

  async function connectWallet() {
    setErr('');
    try {
      const eth = window.ethereum;
      if (!eth) {
        setErr('Нет кошелька (window.ethereum). Открой в Base App / Coinbase Wallet / MetaMask.');
        return;
      }
      await eth.request({ method: 'eth_requestAccounts' });
      await refreshWalletState();
    } catch (e) {
      setErr(formatError(e));
    }
  }

  async function switchToMainnet() {
    setErr('');
    try {
      const eth = window.ethereum;
      if (!eth) return;

      try {
        await eth.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: ACTIVE.chainIdHex }],
        });
      } catch (switchErr) {
        if (switchErr?.code === 4902) {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: ACTIVE.chainIdHex,
                chainName: ACTIVE.chainName,
                nativeCurrency: ACTIVE.nativeCurrency,
                rpcUrls: ACTIVE.rpcUrls,
                blockExplorerUrls: ACTIVE.blockExplorerUrls,
              },
            ],
          });
        } else {
          throw switchErr;
        }
      }

      await refreshWalletState();
    } catch (e) {
      setErr(formatError(e));
    }
  }

  async function refreshBaseNameManual() {
    setErr('');
    try {
      const eth = window.ethereum;
      if (!eth || !addr) return;
      await resolveBaseName(eth, addr);
    } catch (e) {
      setErr(formatError(e));
    }
  }

  useEffect(() => {
    const eth = window.ethereum;
    setHasProvider(!!eth);
    if (!eth) return;

    const onAccountsChanged = () => refreshWalletState();
    const onChainChanged = () => refreshWalletState();

    eth.on?.('accountsChanged', onAccountsChanged);
    eth.on?.('chainChanged', onChainChanged);

    refreshWalletState();

    try {
      sdk.actions.ready();
    } catch (e) {
      console.log('sdk.actions.ready() skipped:', e);
    }

    return () => {
      eth.removeListener?.('accountsChanged', onAccountsChanged);
      eth.removeListener?.('chainChanged', onChainChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== Game logic =====
  function guessNow() {
    setErr('');
    setTxMsg('');
    setTxHash('');

    const k = interpretedK;
    const rangeErr = validateRangeK(k);
    if (rangeErr) {
      setErr(rangeErr);
      return;
    }

    const nextAttempts = attemptsThisRound + 1;
    setAttemptsThisRound(nextAttempts);

    if (k === targetK) {
      const roundScore = Math.max(0, MAX_ATTEMPTS - nextAttempts + 1);

      setLastRoundScore(roundScore);
      setTotalScore((s) => s + roundScore);
      setBestRoundScore((b) => Math.max(b, roundScore));

      setHint('✅ Угадал!');
      setWins((w) => w + 1);
      setRounds((r) => r + 1);

      const win = { score: roundScore, guessK: k, ts: Date.now() };
      setLastWin(win);
      setLastSavedTx('');

      setTimeout(() => {
        setTargetK(randomInt(MIN_K, MAX_K));
        setAttemptsThisRound(0);
        setInputRaw('');
        setHint('');
      }, 900);

      return;
    }

    if (k < targetK) setHint('⬆️ Выше');
    else setHint('⬇️ Ниже');

    if (nextAttempts >= MAX_ATTEMPTS) {
      setRounds((r) => r + 1);
      setHint(`❌ Раунд проигран. Было: ${targetK}k`);
      setLastRoundScore(0);

      setTimeout(() => {
        setTargetK(randomInt(MIN_K, MAX_K));
        setAttemptsThisRound(0);
        setInputRaw('');
        setHint('');
      }, 1100);
    }
  }

  // ===== Leaderboard =====
  async function loadLeaderboard(force = false) {
    setLbLoading(true);
    setLbInfo('');
    try {
      const url = `/api/leaderboard?limit=10${force ? `&t=${Date.now()}` : ''}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();

      const ok = json?.ok === true || json?.ok === 'true';
      if (!ok) {
        setLbRows([]);
        setLbInfo('Лидерборд временно недоступен.');
      } else {
        const rows = Array.isArray(json?.rows) ? json.rows : [];
        setLbRows(rows);
        setLbInfo(rows.length === 0 ? 'Пока нет onchain побед. Сыграй и нажми "Сохранить результат".' : '');
      }
    } catch {
      setLbRows([]);
      setLbInfo('Лидерборд временно недоступен.');
    } finally {
      setLbLoading(false);
    }
  }

  useEffect(() => {
    loadLeaderboard(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== HARD DIAG =====
  async function diagnose(provider) {
    const net = await provider.getNetwork();
    const currentChainId = Number(net.chainId);

    const code = await provider.getCode(CONTRACT_ADDRESS);
    const isContract = code && code !== '0x';

    return { currentChainId, isContract, codeLen: code === '0x' ? 0 : code.length };
  }

  // ===== Onchain save =====
  async function saveOnchain() {
    setErr('');
    setTxMsg('');
    setTxHash('');

    try {
      const eth = window.ethereum;
      if (!eth) return setErr('Нет provider (window.ethereum). Открой в кошельке (Base App/Coinbase/MetaMask).');

      const accounts = await eth.request({ method: 'eth_accounts' });
      if (!Array.isArray(accounts) || accounts.length === 0) {
        await eth.request({ method: 'eth_requestAccounts' });
      }
      await refreshWalletState();

      if (!lastWin) return setErr('Нет победы для сохранения. Сначала выиграй раунд.');

      setIsSaving(true);

      const provider = new ethers.BrowserProvider(eth);

      setTxMsg('Диагностика сети/контракта...');
      const d = await diagnose(provider);

      if (d.currentChainId !== ACTIVE.chainIdDec) {
        setIsSaving(false);
        return setErr(
          `Не та сеть. Сейчас chainId=${d.currentChainId}. Нужна ${ACTIVE.chainName} (${ACTIVE.chainIdDec}). Нажми "Switch to Base Mainnet".`
        );
      }

      if (!d.isContract) {
        setIsSaving(false);
        return setErr(`По адресу ${CONTRACT_ADDRESS} НЕТ контракта (getCode=0x). Проверь адрес/деплой в Base Mainnet.`);
      }

      const signer = await provider.getSigner();
      const signerAddr = await signer.getAddress();
      if (!signerAddr) {
        setIsSaving(false);
        return setErr('Signer не получен (кошелёк не дал адрес).');
      }

      const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

      setTxMsg('Пробую simulate (staticCall)...');
      try {
        await contract.played.staticCall(BigInt(lastWin.score), BigInt(lastWin.guessK));
      } catch (se) {
        console.error('staticCall error', se);
        setTxMsg('simulate (staticCall) упал — отправляю транзакцию с gasLimit...');
      }

      let gasLimit = 180000n;
      try {
        const est = await contract.played.estimateGas(BigInt(lastWin.score), BigInt(lastWin.guessK));
        gasLimit = est + est / 4n;
      } catch (ge) {
        console.error('estimateGas error', ge);
        gasLimit = 200000n;
      }

      setTxMsg('Открываю кошелёк для подтверждения...');
      const tx = await contract.played(BigInt(lastWin.score), BigInt(lastWin.guessK), { gasLimit });

      setTxMsg('Ожидаю подтверждение...');
      const receipt = await tx.wait();

      const hash = receipt?.hash || tx?.hash || '';
      setTxHash(hash);
      setTxMsg('✅ Записано onchain!');
      setLastSavedTx(hash);

      await loadLeaderboard(true);
    } catch (e) {
      console.error('saveOnchain error', e);
      setErr(formatError(e));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundImage: "url('/bg.jpg')",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'top center',
        backgroundSize: 'contain',
        backgroundColor: '#061a33',
        padding: 16,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <main
        style={{
          fontFamily: 'Arial, sans-serif',
          width: '100%',
          maxWidth: 980,
          background: 'rgba(255,255,255,0.92)',
          borderRadius: 16,
          padding: 16,
          boxShadow: '0 8px 28px rgba(0,0,0,0.25)',
        }}
      >
        <h2 style={{ marginBottom: 6 }}>Mini App: BTC Guess ({ACTIVE.chainName})</h2>

        <div style={{ marginBottom: 8, color: '#444' }}>
          Допустимые уровни: <b>{MIN_K}k</b> … <b>{MAX_K}k</b>
        </div>

        <div style={{ marginBottom: 10, color: '#444' }}>
          Вводи число <b>{MIN_K}…{MAX_K}</b> (например: <b>69</b> = <b>69k</b> = <b>$69,000</b>). Попыток на раунд:{' '}
          <b>{MAX_ATTEMPTS}</b>
        </div>

        {/* PROFILE CARD */}
        <div
          style={{
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 10,
            border: '1px solid #e5e7eb',
            borderRadius: 12,
            background: '#fafbff',
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: '50%',
              overflow: 'hidden',
              border: '1px solid #e5e7eb',
              background: '#fff',
              flex: '0 0 44px',
            }}
          >
            {profileAvatar ? (
              <img src={profileAvatar} alt="avatar" style={{ width: '100%', height: '100%' }} />
            ) : (
              <div style={{ width: '100%', height: '100%', background: '#eef3f9' }} />
            )}
          </div>

          <div style={{ lineHeight: 1.25, width: '100%' }}>
            <div style={{ fontWeight: 700 }}>
              Base Name: <span style={{ fontFamily: 'monospace' }}>{profileName}</span>
            </div>

            {baseNameNote ? (
              <div style={{ fontSize: 12, color: '#777', marginTop: 2 }}>{baseNameNote}</div>
            ) : null}

            <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
              {status}
              {isConnected && !isCorrectChain ? ' · не та сеть' : ''}
            </div>

            <div style={{ fontSize: 12, color: '#8b8b8b', wordBreak: 'break-all' }}>
              Адрес: {addr ? shortAddr(addr) : '-'}
            </div>
          </div>
        </div>

        {/* TECH INFO */}
        <div style={{ marginBottom: 10 }}>
          <div>
            <b>ChainId:</b> {chainId ?? '-'}
          </div>
          <div style={{ wordBreak: 'break-all' }}>
            <b>Контракт:</b> {CONTRACT_ADDRESS}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          {!isConnected && (
            <button style={{ padding: '10px 14px' }} onClick={connectWallet} disabled={!hasProvider}>
              Подключить кошелёк
            </button>
          )}

          {isConnected && !isCorrectChain && (
            <button style={{ padding: '10px 14px' }} onClick={switchToMainnet}>
              Switch to Base Mainnet
            </button>
          )}

          <button style={{ padding: '10px 14px' }} onClick={refreshBaseNameManual} disabled={!isConnected}>
            Обновить Base Name
          </button>

          <button style={{ padding: '10px 14px' }} onClick={resetRound}>
            Новый раунд
          </button>

          <button
            style={{ padding: '10px 14px' }}
            onClick={saveOnchain}
            disabled={!hasProvider || !lastWin || isSaving}
            title={!lastWin ? 'Сначала выиграй раунд' : 'Записать победу onchain'}
          >
            {isSaving ? 'Сохраняю…' : 'Сохранить результат (onchain)'}
          </button>

          <button style={{ padding: '10px 14px' }} onClick={() => loadLeaderboard(true)} disabled={lbLoading}>
            {lbLoading ? 'Обновляю…' : 'Обновить лидерборд'}
          </button>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ marginBottom: 6 }}>
            <b>Угадай уровень BTC (k):</b> введи <b>{MIN_K}…{MAX_K}</b>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={inputRaw}
              onChange={onInputChange}
              inputMode="numeric"
              placeholder="например 69"
              style={{ width: 180, padding: '10px 12px', fontSize: 16 }}
              maxLength={3}
            />

            <button style={{ padding: '10px 14px' }} onClick={guessNow}>
              Проверить
            </button>

            <div style={{ color: '#333' }}>
              {interpretedK !== null ? (
                <span>
                  Интерпретируется как <b>{interpretedLabel}</b> (<b>${interpretedUsd?.toLocaleString('en-US')}</b>)
                </span>
              ) : (
                <span style={{ color: '#777' }}>Введите число (2–3 цифры)</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <b>Подсказка:</b> <span style={{ marginLeft: 8 }}>{hint || '-'}</span>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div>
            Попыток (в этом раунде): <b>{attemptsThisRound}</b> / {MAX_ATTEMPTS}
          </div>
          <div>
            Раунды: <b>{rounds}</b>
          </div>
          <div>
            Победы: <b>{wins}</b>
          </div>
          <div>
            Очки за последнюю победу: <b>{lastRoundScore}</b>
          </div>
          <div>
            Лучший результат за раунд: <b>{bestRoundScore}</b>
          </div>
          <div>
            Суммарные очки (total): <b>{totalScore}</b>
          </div>
        </div>

        <div style={{ padding: 12, border: '1px solid #ddd', borderRadius: 10, marginBottom: 14 }}>
          <div style={{ marginBottom: 6 }}>
            <b>Последняя победа (для onchain):</b>
          </div>
          {lastWin ? (
            <div>
              <div>
                guess: <b>{lastWin.guessK}k</b>
              </div>
              <div>
                score: <b>{lastWin.score}</b>
              </div>
              <div style={{ wordBreak: 'break-all' }}>
                saved tx: <b>{lastSavedTx ? lastSavedTx : '-'}</b>
              </div>
            </div>
          ) : (
            <div style={{ color: '#666' }}>Пока нет победы.</div>
          )}
        </div>

        <div style={{ padding: 12, border: '1px solid #ddd', borderRadius: 10 }}>
          <div style={{ marginBottom: 6 }}>
            <b>Leaderboard (onchain)</b>
          </div>

          {lbInfo && <div style={{ color: '#666', marginBottom: 8 }}>{lbInfo}</div>}

          {lbRows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: 8 }}>#</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: 8 }}>Address</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: 8 }}>Best score</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #eee', padding: 8 }}>Guess</th>
                  </tr>
                </thead>
                <tbody>
                  {lbRows.map((r, i) => (
                    <tr key={`${r.user}-${i}`}>
                      <td style={{ borderBottom: '1px solid #f2f2f2', padding: 8 }}>{i + 1}</td>
                      <td style={{ borderBottom: '1px solid #f2f2f2', padding: 8, wordBreak: 'break-all' }}>{r.user}</td>
                      <td style={{ borderBottom: '1px solid #f2f2f2', padding: 8 }}>
                        <b>{r.score}</b>
                      </td>
                      <td style={{ borderBottom: '1px solid #f2f2f2', padding: 8 }}>{r.guessK}k</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {txMsg && (
          <div style={{ marginTop: 12 }}>
            <b>Onchain:</b> {txMsg}
            {txHash && (
              <div style={{ wordBreak: 'break-all', marginTop: 6 }}>
                <b>Tx:</b>{' '}
                <a href={`${ACTIVE.blockExplorerUrls[0]}/tx/${txHash}`} target="_blank" rel="noreferrer">
                  {txHash}
                </a>
              </div>
            )}
          </div>
        )}

        {err && (
          <div style={{ marginTop: 12, color: 'crimson', whiteSpace: 'pre-wrap' }}>
            <b>Ошибка:</b> {err}
          </div>
        )}
      </main>
    </div>
  );
}
