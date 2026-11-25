import { store } from '../store';
import { button, card, formatSeconds, h, stat } from '../dom';
import { resultPowerChart } from '../charts';
import { runSimulation } from '../../lib/simulation';
import { downloadText, powerCurveCSVWithLoad, scenarioMarkdown } from '../../lib/export';

export function renderPowerPage(root: HTMLElement): () => void {
  let cancelled = false;

  const paint = () => {
    if (cancelled) return;
    root.replaceChildren();
    const plan = store.state.plan;
    const result = store.state.result;

    root.append(h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, '发电曲线'), h('p', { class: 'page-desc' }, '输出一整轨功率曲线，自动标地影段、全轨最小功率点和光照区最差功率点，并与载荷开机阈值比较。')),
      h('div', { class: 'head-actions' },
        button('重新推演', async () => {
          store.setRunning(true);
          let result = null;
          try {
            result = await runSimulation(plan);
            store.setResult(result);
          } finally {
            store.setRunning(false);
          }
          if (result && !cancelled) paint();
        }, { variant: 'primary', disabled: store.state.running }),
        button('导出功率 CSV', () => result && downloadText('power_curve.csv', powerCurveCSVWithLoad(result, plan.settings.nominalLoadW)), { variant: 'success', icon: '⬇', disabled: !result }),
        button('导出工况说明 MD', () => downloadText('scenario_report.md', scenarioMarkdown(plan, result ?? undefined), 'text/markdown;charset=utf-8'), { variant: 'ghost', icon: '📄' }),
      ),
    ));

    if (!result) {
      root.append(card('尚无推演结果', h('div', { class: 'empty-state' },
        h('p', {}, '请先运行整轨推演。'),
        button('立即运行', async () => {
          store.setRunning(true);
          let result = null;
          try {
            result = await runSimulation(plan);
            store.setResult(result);
          } finally {
            store.setRunning(false);
          }
          if (result && !cancelled) paint();
        }, { variant: 'primary' }),
      )));
      return;
    }

    const load = plan.settings.nominalLoadW;
    const minMargin = result.minTotal.powerW - load;
    const sunlitMargin = result.minSunlit ? result.minSunlit.powerW - load : null;
    const stats = h('div', { class: 'stat-grid' },
      stat('轨道周期', `${(result.orbitPeriodSec / 60).toFixed(1)} min`, `${result.epochCount} 个历元`),
      stat('全轨最小', `${result.minTotal.powerW.toFixed(1)} W`, `${formatSeconds(result.minTotal.tSec)} · ${result.epochs[result.minTotal.index]?.inEclipse ? '地影' : '光照/入射角最低'}`, 'bad'),
      stat('光照区最差', result.minSunlit ? `${result.minSunlit.powerW.toFixed(1)} W` : '—', result.minSunlit ? formatSeconds(result.minSunlit.tSec) : '', sunlitMargin !== null && sunlitMargin >= 0 ? 'good' : 'warn'),
      stat('最弱裕度', `${minMargin >= 0 ? '+' : ''}${minMargin.toFixed(0)} W`, `相对载荷 ${load} W`, minMargin >= 0 ? 'good' : 'bad'),
      stat('全轨发电量', `${result.energyWh.toFixed(1)} Wh`, '梯形积分'),
      stat('余弦自检', `${result.cosineCheck.maxErrorPct.toFixed(4)}%`, result.cosineCheck.passed ? '无遮挡解析解 <0.5%' : '超过 0.5%', result.cosineCheck.passed ? 'good' : 'bad'),
    );
    root.append(stats);

    const chartCard = card('整轨功率曲线', h('div', { class: 'chart-wrap', html: resultPowerChart(result, load) }));
    root.append(chartCard);

    const bottom = h('div', { class: 'two-col' });
    const eclipseCard = card('地影进出时刻', h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '进入 s'), h('th', {}, '退出 s'), h('th', {}, '持续 min'), h('th', {}, '起始 UTC'))),
      h('tbody', {}, ...result.eclipseIntervals.map((iv) => h('tr', {},
        h('td', {}, iv.startSec.toFixed(0)),
        h('td', {}, iv.endSec.toFixed(0)),
        h('td', {}, ((iv.endSec - iv.startSec) / 60).toFixed(2)),
        h('td', { class: 'mono' }, result.epochs[iv.startIndex]?.dateISO ?? ''),
      ))),
    ));

    const minRows = result.epochs
      .map((e) => ({ t: e.tSec, p: e.totalPowerW, eclipse: e.inEclipse }))
      .sort((a, b) => a.p - b.p)
      .slice(0, 12);
    const minCard = card('最低功率历元 Top 12', h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '时刻'), h('th', {}, 's'), h('th', {}, '功率 W'), h('th', {}, '地影'))),
      h('tbody', {}, ...minRows.map((r) => h('tr', {},
        h('td', {}, formatSeconds(r.t)), h('td', {}, r.t.toFixed(0)), h('td', { class: r.p < load ? 'bad-text' : 'good-text' }, r.p.toFixed(1)), h('td', {}, r.eclipse ? '是' : '否'),
      ))),
    )));
    bottom.append(eclipseCard, minCard);
    root.append(bottom);
  };

  paint();
  return () => { cancelled = true; };
}
