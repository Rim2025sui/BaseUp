'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';

const BASE_CHAIN_ID_DEC = 8453;
const BASE_CHAIN_ID_HEX = '0x2105';

// Mainnet public RPC for ENS reverse lookup (.base.eth often resolves here)
const MAINNET_RPC = 'https://cloudflare-eth.com';

function shortAddr(a) {
  if (!a) return '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function parseChainIdToDec(chainId) {
  // chainId may be: "0x2105" (string hex) or 8453 (number)
  if (chainId == null) return null;
  if (typeof chainId === 'number') return chainId;
  if (typeof chainId === 'string') {
    if (chainId.startsWith('0x')) return parseInt(chainId, 16);
    const n = Number(chainId);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function safeLookupBaseNameViaMainnet(address) {
  try {
    const p = new ethers.JsonRpcProvider(MAINNET_RPC);
    // ethers v6: lookupAddress uses ENS reverse record on mainnet
    const name = await p.lookupAddress(address);
    return name || null;
  } catch (e) {
    return null;
  }
}

export default function Page() {
  const [mounted, setMounted] = useState(false);

  const [ethDetected, setEthDetected] = useState(false);
  const [status, setStatus] = useState('Не подключено');

  const [address, setAddress] = useState('');
  const [chainIdRaw, setChainIdRaw] = useState(null);
  const chainIdDec = useMemo(() => parseChainIdToDec(chainIdRaw), [chainIdRaw]);
  const chainIdHex = useMemo(() => {
    if (typeof chainIdRaw === 'string' && chainIdRaw.startsWith('0x')) return chainIdRaw;
    if (typeof chainIdDec === 'number') return '0x' + chainIdDec.toString(16);
    return '';
  }, [chainIdRaw, chainIdDec]);

  const [baseName, setBaseName] = useState('');
  const [baseNameNote, setBaseNameNote] = useState('');

  const isOnBase = chainIdDec === BASE_CHAIN_ID_DEC;

  // UI state for buttons
  const [connectBusy, setConnectBusy] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);

  useEffect(() => {
    setMounted(true);
    setEthDetected(Boolean(globalThis?.window?.ethereum));
  }, []);

  async function refreshFromWallet(silent = true) {
    try {
      const { ethereum } = window;
      if (!ethereum) {
        setEthDetected(false);
        setStatus('Нет web3 провайдера (window.ethereum)');
        return;
      }
      setEthDetected(true);

      const provider = new ethers.BrowserProvider(ethereum);
      const net = await provider.getNetwork();
      // net.chainId in ethers v6 is bigint
      const dec = Number(net.chainId);
      setChainIdRaw(dec);

      const accounts = await provider.send('eth_accounts', []);
      if (accounts && accounts[0]) {
        setAddress(ethers.getAddress(accounts[0]));
        setStatus(silent ? 'Подключено' : 'Подключено');
      } else {
        setAddress('');
        setStatus('Не подключено');
      }
    } catch (e) {
      setStatus(`Ошибка refresh: ${String(e?.message || e)}`);
    }
  }

  async function connect() {
    try {
      setConnectBusy(true);
      setBaseName('');
      setBaseNameNote('');

      const { ethereum } = window;
      if (!ethereum) {
        setEthDetected(false);
        setStatus('Нет web3 провайдера (window.ethereum)');
        return;
      }

      const provider = new ethers.BrowserProvider(ethereum);

      // IMPORTANT: request accounts on button click
      const accounts = await provider.send('eth_requestAccounts', []);
      if (!accounts || !accounts[0]) {
        setStatus('Подключение отменено');
        return;
      }

      const addr = ethers.getAddress(accounts[0]);
      setAddress(addr);

      const net = await provider.getNetwork();
      const dec = Number(net.chainId);
      setChainIdRaw(dec);

      setStatus('Подключено');

      // after connect -> try resolve name
      await resolveBaseName(addr);

    } catch (e) {
      setStatus(`Connect error: ${String(e?.message || e)}`);
    } finally {
      setConnectBusy(false);
    }
  }

  async function resolveBaseName(addr = address) {
    if (!addr) return;
    try {
      setNameBusy(true);
      setBaseName('');
      setBaseNameNote('Ищу Base Name…');

      // 1) mainnet ENS reverse (most reliable for .base.eth)
      const name = await safeLookupBaseNameViaMainnet(addr);

      if (name) {
        setBaseName(name);
        setBaseNameNote('Ок (ENS reverse на Ethereum mainnet)');
        return;
      }

      // If null -> give actionable note
      setBaseName('');
      setBaseNameNote('не найден (lookup вернул null)');
    } finally {
      setNameBusy(false);
    }
  }

  useEffect(() => {
    if (!mounted) return;

    // initial read
    refreshFromWallet(true);

    const { ethereum } = window;
    if (!ethereum) return;

    const onAccountsChanged = (accs) => {
      const a = accs && accs[0] ? ethers.getAddress(accs[0]) : '';
      setAddress(a);
      setBaseName('');
      setBaseNameNote('');
      if (a) {
        setStatus('Подключено');
        resolveBaseName(a);
      } else {
        setStatus('Не подключено');
      }
    };

    const onChainChanged = (cid) => {
      // cid usually "0x2105"
      setChainIdRaw(cid);
      // re-sync everything
      refreshFromWallet(true);
    };

    ethereum.on?.('accountsChanged', onAccountsChanged);
    ethereum.on?.('chainChanged', onChainChanged);

    return () => {
      ethereum.removeListener?.('accountsChanged', onAccountsChanged);
      ethereum.removeListener?.('chainChanged', onChainChanged);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const needBaseText = isOnBase
    ? ''
    : `ChainId: ${chainIdHex || String(chainIdRaw || '')} (нужен ${BASE_CHAIN_ID_DEC})`;

  return (
    <div style={{ minHeight: '100vh', padding: 16, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial' }}>
      <h2 style={{ margin: 0, marginBottom: 8 }}>Mini App: BTC Guess (Base Mainnet)</h2>
      <div style={{ opacity: 0.8, marginBottom: 12 }}>
        Допустимые уровни: <b>60k … 120k</b><br />
        Вводи число <b>60…120</b> (например: 69 = 69k = $69,000). Попыток на раунд: <b>7</b>
      </div>

      <div style={{
        border: '1px solid #e5e7eb',
        borderRadius: 14,
        padding: 12,
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{address ? shortAddr(address) : '—'}</div>
          <div style={{ opacity: 0.85 }}>Статус: {status}</div>
          <div style={{ opacity: 0.85 }}>
            {needBaseText ? (
              <span style={{ color: '#b45309' }}>{needBaseText}</span>
            ) : (
              <span>ChainId: {chainIdHex || '—'} ({chainIdDec ?? '—'})</span>
            )}
          </div>
        </div>

        <button
          onClick={connect}
          disabled={connectBusy}
          style={{
            padding: '10px 16px',
            borderRadius: 12,
            border: '1px solid #2563eb',
            background: connectBusy ? '#93c5fd' : '#2563eb',
            color: 'white',
            fontWeight: 700,
            cursor: connectBusy ? 'not-allowed' : 'pointer',
            minWidth: 110
          }}
        >
          {connectBusy ? '...' : 'Connect'}
        </button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ opacity: 0.85 }}>
          Адрес: <b>{address || '—'}</b>
        </div>
        <div style={{ opacity: 0.85 }}>
          Base Name:{' '}
          <b>{baseName ? baseName : 'не найден'}</b>{' '}
          <span style={{ opacity: 0.8 }}>
            {baseNameNote ? `(${baseNameNote})` : ''}
          </span>
        </div>

        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button
            onClick={() => resolveBaseName(address)}
            disabled={!address || nameBusy}
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              border: '1px solid #e5e7eb',
              background: (!address || nameBusy) ? '#f3f4f6' : 'white',
              cursor: (!address || nameBusy) ? 'not-allowed' : 'pointer',
              fontWeight: 700
            }}
          >
            {nameBusy ? 'Ищу…' : 'Обновить Base Name'}
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 13, opacity: 0.75, lineHeight: 1.35 }}>
          Если Base Name “не найден”, это почти всегда значит, что для этого адреса не выставлена обратная запись (reverse).
          В Base Names у тебя имя видно — ок. Но reverse может быть не выставлен/не обновился.
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10 }}>
        <button
          style={{ padding: 14, borderRadius: 14, border: '1px solid #e5e7eb', background: 'white', fontWeight: 800 }}
          onClick={() => alert('Новый раунд (пока заглушка UI)')}
        >
          Новый раунд
        </button>

        <button
          style={{ padding: 14, borderRadius: 14, border: '1px solid #e5e7eb', background: '#f3f4f6', fontWeight: 800, opacity: 0.65 }}
          disabled
        >
          Сохранить результат (onchain)
        </button>

        <button
          style={{ padding: 14, borderRadius: 14, border: '1px solid #e5e7eb', background: 'white', fontWeight: 800 }}
          onClick={() => alert('Лидерборд (пока заглушка UI)')}
        >
          Обновить лидерборд
        </button>
      </div>

      <div style={{ marginTop: 14, borderTop: '1px solid #eee', paddingTop: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 900 }}>Угадай уровень BTC (k): введи 60…120</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <input
            placeholder="например 69"
            style={{ flex: 1, padding: 12, borderRadius: 12, border: '1px solid #e5e7eb', fontSize: 16 }}
          />
          <button
            style={{ padding: '12px 16px', borderRadius: 12, border: '1px solid #e5e7eb', fontWeight: 800 }}
            onClick={() => alert('Проверить (заглушка UI)')}
          >
            Проверить
          </button>
        </div>
        <div style={{ marginTop: 10, opacity: 0.8 }}>
          Подсказка: -
        </div>
        <div style={{ marginTop: 6, opacity: 0.8 }}>
          Попыток (в этом раунде): 0 / 7<br />
          Раунды: 0<br />
          Победы: 0<br />
          Очки за последнюю победу: 0
        </div>
      </div>
    </div>
  );
}
