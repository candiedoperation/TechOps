const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function value(item){return item?.value ?? '—'}
function render(data){
  $('status').textContent=`${data.success?'Success':'Failed'} · ${data.semester} · ${data.materialized_assets.length} assets materialized`;
  $('sources').innerHTML=`<p><b>Partition:</b> ${esc(data.semester)}</p><p><b>Assets:</b> ${data.materialized_assets.map(esc).join(', ')}</p><p class="muted">${esc(data.synthetic_warning)}</p>`;
  $('ranking').innerHTML=data.ranking.ranked.map((r,i)=>`<div class="person"><span><b>${i+1}. ${esc(r.member_id)}</b><br><small class="muted">coverage ${r.coverage}</small></span><span class="score">${r.score}</span></div>`).join('')+`<p class="muted">Unavailable: ${data.ranking.unavailable.map(esc).join(', ')}</p>`;
  $('features').innerHTML=Object.values(data.features.features).map(f=>`<div class="card"><h3>${esc(f.member_id)}</h3>${[['App Dev tenure',f.appdev_tenure],['Event attendance',f.event_attendance],['Collaborative PRs',f.collaborative_prs],['Commit frequency',f.commit_frequency],['Growth',f.growth],['SOW contribution',f.sow_final_contribution],['Peer review avg',f.peer_review_average],['Review turnaround',f.review_turnaround_days],['Responsibility Index',f.responsibility_index],['Experience difficulty',f.experience_difficulty],['Performance consistency',f.performance_consistency],['Semantic SOW / LLM',f.sow_semantic_llm]].map(([k,v])=>`<div class="metric"><span>${esc(k)}</span><b>${esc(value(v))}</b></div>`).join('')}</div>`).join('');
  $('audit').innerHTML=data.audit.flags.map(f=>`<div class="flag"><b>${esc(f.project)}</b> · ${esc(f.issue)}<br><small>${esc(f.source)}</small></div>`).join('')||'<p>No findings.</p>';
  $('matching').innerHTML=data.matching.matches.map(m=>`<div class="match"><b>${esc(m.project)}</b> · ${esc(m.member_id||'No match')} ${m.role?`(${esc(m.role)})`:''}<br><small>${esc(m.sow_overlap?.join(', ')||m.reason||m.semantic_match)}</small></div>`).join('')+`<p class="muted">${esc(data.matching.semantic_gap)}</p>`;
}
async function run(){ $('run').disabled=true; $('status').textContent='Materializing Dagster partition…'; try{const r=await fetch(`/api/run?semester=${encodeURIComponent($('semester').value)}`);const data=await r.json();if(!r.ok)throw new Error(data.error);render(data)}catch(e){$('status').textContent=`Error: ${e.message}`}finally{$('run').disabled=false}}
$('run').addEventListener('click',run);run();
