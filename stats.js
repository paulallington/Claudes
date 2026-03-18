#!/usr/bin/env node
// Usage: node stats.js [period]
// period: "today", "week", "month", "all", or a date like "2026-03-17"
// No args = show since last check + all-time totals

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'paulallington/Claudes';
const STATS_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.claudes', 'download-stats.json');

function fetchCounts() {
    const raw = execFileSync('gh', [
        'api', `repos/${REPO}/releases`,
        '--jq', '.[] | {tag: .tag_name, published: .published_at, assets: [.assets[] | {name: .name, downloads: .download_count}]}'
    ], { encoding: 'utf-8' });

    const releases = {};
    let totalExe = 0, totalYml = 0;
    for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        const r = JSON.parse(line);
        const exe = r.assets.filter(a => a.name.endsWith('.exe') && !a.name.endsWith('.blockmap')).reduce((s, a) => s + a.downloads, 0);
        const yml = r.assets.filter(a => a.name.endsWith('.yml')).reduce((s, a) => s + a.downloads, 0);
        releases[r.tag] = { exe, yml, published: r.published };
        totalExe += exe;
        totalYml += yml;
    }
    return { releases, totalExe, totalYml };
}

function loadStats() {
    try {
        return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    } catch {
        return { snapshots: [] };
    }
}

function saveStats(stats) {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function findSnapshotSince(snapshots, since) {
    for (let i = snapshots.length - 1; i >= 0; i--) {
        if (new Date(snapshots[i].timestamp) <= since) return snapshots[i];
    }
    return null;
}

function formatDelta(current, baseline) {
    const deltaExe = current.totalExe - (baseline ? baseline.totalExe : 0);
    const deltaYml = current.totalYml - (baseline ? baseline.totalYml : 0);
    return { deltaExe, deltaYml };
}

function printTable(label, current, baseline) {
    const { deltaExe, deltaYml } = formatDelta(current, baseline);
    const period = baseline ? `since ${new Date(baseline.timestamp).toLocaleDateString()}` : 'all time';
    console.log(`\n  ${label} (${period}):`);
    console.log(`    New installs:   ${deltaExe}`);
    console.log(`    Update checks:  ${deltaYml}`);

    if (deltaExe > 0 || deltaYml > 0) {
        console.log(`    By version:`);
        for (const [tag, counts] of Object.entries(current.releases)) {
            const bCounts = baseline?.releases?.[tag] || { exe: 0, yml: 0 };
            const dExe = counts.exe - bCounts.exe;
            const dYml = counts.yml - bCounts.yml;
            if (dExe > 0 || dYml > 0) {
                console.log(`      ${tag}: +${dExe} installs, +${dYml} update checks`);
            }
        }
    }
}

// Main
const arg = process.argv[2];
const now = new Date();
const current = fetchCounts();
const stats = loadStats();

console.log('\n  Claudes Download Stats');
console.log('  ' + '-'.repeat(38));

// All-time totals
console.log(`\n  All time:`);
console.log(`    Total installs:      ${current.totalExe}`);
console.log(`    Total update checks: ${current.totalYml}`);
console.log(`    Releases:            ${Object.keys(current.releases).length}`);

// Since last check
const lastSnapshot = stats.snapshots.length > 0 ? stats.snapshots[stats.snapshots.length - 1] : null;
if (lastSnapshot) {
    const elapsed = now - new Date(lastSnapshot.timestamp);
    const hours = Math.round(elapsed / 3600000);
    const label = hours < 24 ? `Last ${hours}h` : `Last ${Math.round(hours / 24)}d`;
    printTable(label, current, lastSnapshot);
}

// Period-based view
if (arg) {
    let since;
    if (arg === 'today') {
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (arg === 'week') {
        since = new Date(now - 7 * 86400000);
    } else if (arg === 'month') {
        since = new Date(now - 30 * 86400000);
    } else if (arg === 'all') {
        // Already shown above
    } else {
        since = new Date(arg);
    }
    if (since && !isNaN(since)) {
        const baseline = findSnapshotSince(stats.snapshots, since);
        if (baseline) {
            printTable(arg, current, baseline);
        } else {
            console.log(`\n  No snapshot data from ${arg} -- stats tracking started ${stats.snapshots.length > 0 ? new Date(stats.snapshots[0].timestamp).toLocaleDateString() : 'just now'}`);
        }
    }
}

// Save snapshot
stats.snapshots.push({
    timestamp: now.toISOString(),
    totalExe: current.totalExe,
    totalYml: current.totalYml,
    releases: current.releases
});

// Keep max 1000 snapshots
if (stats.snapshots.length > 1000) {
    stats.snapshots = stats.snapshots.slice(-1000);
}

saveStats(stats);
console.log(`\n  Snapshot saved. Run again later to see deltas.`);
console.log('');
