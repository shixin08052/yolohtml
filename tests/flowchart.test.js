import { describe, it, expect } from 'vitest';
import { flowStatuses, flowSvg, currentNode, flowNodes, MAIN_NODES, SIDE_NODES } from '../src/ui/flowchart.js';

const main = (st) => MAIN_NODES.map((n) => st[n.id]).join(' ');

describe('流程图状态', () => {
  it('还没有照片：第一步进行中，其余未开始，出错分支都不亮', () => {
    const st = flowStatuses({ stage: 'idle' });
    expect(main(st)).toBe('active todo todo todo todo todo todo todo todo');
    expect(SIDE_NODES.every((n) => st[n.id] === 'idle')).toBe(true);
    expect(currentNode(st).id).toBe('input');
  });

  it('读取中：选择照片完成，读取照片进行中', () => {
    expect(main(flowStatuses({ stage: 'idle', loading: true }))).toBe('done active todo todo todo todo todo todo todo');
  });

  it('位姿求出、检测进行中', () => {
    const st = flowStatuses({ stage: 'posed' });
    expect(main(st)).toBe('done done done done active todo todo todo todo');
    expect(currentNode(st).id).toBe('detect');
  });

  it('场景建好：转场没播时转场进行中；播放中仍是进行中；播完后等待分拣', () => {
    expect(main(flowStatuses({ stage: 'sceneBuilt' }))).toBe('done done done done done done active todo todo');
    expect(main(flowStatuses({ stage: 'sceneBuilt', transitionDone: true, transitionPlaying: true }))).toBe('done done done done done done active todo todo');
    expect(main(flowStatuses({ stage: 'sceneBuilt', transitionDone: true }))).toBe('done done done done done done done active todo');
    expect(main(flowStatuses({ stage: 'sorting', transitionDone: true }))).toBe('done done done done done done done active todo');
    expect(main(flowStatuses({ stage: 'done', transitionDone: true }))).toBe('done done done done done done done done done');
  });

  it('识别不到码：标定节点和"识别不到码"标红，后面的步骤停住', () => {
    const st = flowStatuses({ stage: 'imageLoaded', error: { step: 'calib' } });
    expect(main(st)).toBe('done done error todo todo todo todo todo todo');
    expect(st.e_calib).toBe('error');
    expect(st.e_pose).toBe('idle');
    expect(currentNode(st).id).toBe('calib');
  });

  it('检测失败：检测标红，"手动框选"进行中；手动框好后检测完成、手动框选完成', () => {
    const st = flowStatuses({ stage: 'posed', error: { step: 'detect' } });
    expect(main(st)).toBe('done done done done error todo todo todo todo');
    expect([st.e_detect, st.manual]).toEqual(['error', 'active']);
    const st2 = flowStatuses({ stage: 'sceneBuilt', manual: true });
    expect([st2.detect, st2.e_detect, st2.manual]).toEqual(['done', 'idle', 'done']);
  });

  it('读不了照片：照片节点标红；上一张照片做完的步骤不再显示为完成', () => {
    const st = flowStatuses({ stage: 'idle', error: { step: 'image' } });
    expect([st.input, st.image, st.e_image]).toEqual(['done', 'error', 'error']);
    expect(main(flowStatuses({ stage: 'done', transitionDone: true, error: { step: 'image' } }))).toBe('done error todo todo todo todo todo todo todo');
  });

  it('有零件够不到：分拣旁的分支显示为提醒', () => {
    expect(flowStatuses({ stage: 'sceneBuilt', skipped: 2 }).e_sort).toBe('warn');
    expect(flowStatuses({ stage: 'posed', skipped: 2 }).e_sort).toBe('idle');
  });
});

describe('演示模式：建好场景后先确认识别结果', () => {
  const demo = (st) => flowNodes({ demo: true }).map((n) => st[n.id]).join(' ');

  it('多一个"确认"节点，排在转场前面；普通模式没有', () => {
    expect(flowNodes({ demo: true }).map((n) => n.id)).toEqual(['input', 'image', 'calib', 'pose', 'detect', 'scene', 'confirm', 'transition', 'sort', 'done']);
    expect('confirm' in flowStatuses({ stage: 'sceneBuilt' })).toBe(false);
  });

  it('场景建好、还没确认：等待确认（即使转场标记为已播放也不算完成）；确认后进入转场', () => {
    const st = flowStatuses({ stage: 'sceneBuilt', demo: true });
    expect(demo(st)).toBe('done done done done done done active todo todo todo');
    expect(currentNode(st).id).toBe('confirm');
    expect(demo(flowStatuses({ stage: 'sceneBuilt', demo: true, transitionDone: true }))).toBe('done done done done done done active todo todo todo');
    expect(demo(flowStatuses({ stage: 'sceneBuilt', demo: true, confirmed: true }))).toBe('done done done done done done done active todo todo');
    expect(demo(flowStatuses({ stage: 'done', demo: true, confirmed: true, transitionDone: true }))).toBe('done done done done done done done done done done');
  });

  it('SVG：节点多一行，分支仍画在各自节点那一行（够不到的提醒挨着分拣）', () => {
    const st = flowStatuses({ stage: 'sceneBuilt', demo: true, skipped: 1 });
    const svg = flowSvg(st);
    expect(svg).toContain('data-node="confirm"');
    const y = (id) => Number(svg.match(new RegExp(`data-node="${id}"><rect x="[\\d.]+" y="([\\d.]+)"`))[1]);
    expect(y('e_sort')).toBe(y('sort'));
    expect(y('manual')).toBe(y('scene'));
    expect(y('sort')).toBeGreaterThan(y('transition'));
  });
});

describe('流程图 SVG', () => {
  it('每个节点一个、带状态类；完成的连线高亮', () => {
    const svg = flowSvg(flowStatuses({ stage: 'calibrated' }));
    expect(svg.startsWith('<svg')).toBe(true);
    for (const n of [...MAIN_NODES, ...SIDE_NODES]) expect(svg).toContain(`data-node="${n.id}"`);
    expect(svg).toContain('class="fc-node fc-active" data-node="pose"');
    expect(svg).toContain('✓ 识别码 · 单应性');
    expect((svg.match(/fc-edge on/g) ?? []).length).toBe(3); // 选择照片→读取→识别→位姿
  });
});
