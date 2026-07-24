/**
 * The only script shipped with a rendered demo. It is generated deterministically, inlined, and
 * pinned by a CSP sha256 hash.
 *
 * It performs NO network access and contains NO content: every string it can display is already in
 * the document (the concierge reads a JSON island written by the renderer from the deterministic
 * FAQ package). There is no free-form input and no runtime model.
 */
export function buildRuntimeScript(): string {
  return `(function(){
"use strict";
var d=document;
function $(s,r){return (r||d).querySelector(s)}
function all(s,r){return Array.prototype.slice.call((r||d).querySelectorAll(s))}

/* ---- language preference (local only; explicit ?lang= always wins) ---- */
var KEY="dv2.lang";
var docLang=d.documentElement.getAttribute("lang")||"";
var params=new URLSearchParams(location.search);
try{
  if(params.get("lang")){ localStorage.setItem(KEY,docLang); }
  else{
    var pref=localStorage.getItem(KEY);
    var alt=d.querySelector('link[rel="alternate"][data-dv2-lang]');
    if(pref&&pref!==docLang&&alt&&alt.getAttribute("data-dv2-lang")===pref){
      location.replace(alt.getAttribute("href"));
      return;
    }
  }
}catch(e){/* storage unavailable: language still works via links */}
all("[data-dv2-lang-link]").forEach(function(a){
  a.addEventListener("click",function(){
    try{localStorage.setItem(KEY,a.getAttribute("data-dv2-lang-link")||docLang)}catch(e){}
  });
});

/* ---- sticky navigation state ---- */
var nav=$(".dv2-nav");
if(nav){
  var onScroll=function(){nav.setAttribute("data-scrolled",window.scrollY>8?"true":"false")};
  onScroll();window.addEventListener("scroll",onScroll,{passive:true});
}

/* ---- mobile navigation ---- */
var toggle=$(".dv2-nav__toggle"),panel=$(".dv2-mobilenav");
if(toggle&&panel){
  var setNav=function(open){
    panel.setAttribute("data-open",open?"true":"false");
    toggle.setAttribute("aria-expanded",open?"true":"false");
    d.body.style.overflow=open?"hidden":"";
    if(!open)toggle.focus();
  };
  toggle.addEventListener("click",function(){setNav(panel.getAttribute("data-open")!=="true")});
  all("a",panel).forEach(function(a){a.addEventListener("click",function(){setNav(false)})});
  d.addEventListener("keydown",function(e){
    if(e.key==="Escape"&&panel.getAttribute("data-open")==="true")setNav(false);
  });
}

/* ---- deterministic FAQ concierge ---- */
var launcher=$(".dv2-concierge__launcher"),cpanel=$(".dv2-concierge__panel"),island=$("#dv2-faq-data");
if(launcher&&cpanel&&island){
  var data={};
  try{data=JSON.parse(island.textContent||"{}")}catch(e){data={}}
  var entries=data.entries||[];
  var log=$(".dv2-concierge__log",cpanel);
  var closeBtn=$(".dv2-concierge__close",cpanel);
  var answered={};
  var add=function(cls,text){
    var el=d.createElement("p");
    el.className="dv2-concierge__msg dv2-concierge__msg--"+cls;
    el.textContent=text;
    log.appendChild(el);
    log.scrollTop=log.scrollHeight;
    return el;
  };
  var focusables=function(){
    return all("button,[href],input,select,textarea,[tabindex]:not([tabindex='-1'])",cpanel)
      .filter(function(el){return !el.hasAttribute("disabled")&&el.offsetParent!==null});
  };
  var lastFocus=null;
  var isOpen=function(){return cpanel.getAttribute("data-open")==="true"};
  var setOpen=function(open){
    cpanel.setAttribute("data-open",open?"true":"false");
    launcher.setAttribute("aria-expanded",open?"true":"false");
    if(open){lastFocus=d.activeElement;var f=focusables();if(f.length)f[0].focus();}
    else if(lastFocus&&lastFocus.focus)lastFocus.focus();
  };
  launcher.addEventListener("click",function(){setOpen(!isOpen())});
  if(closeBtn)closeBtn.addEventListener("click",function(){setOpen(false)});
  // Document-level Escape: a disabled suggestion can move focus out of the panel, so a
  // panel-scoped handler alone would miss it.
  d.addEventListener("keydown",function(e){if(e.key==="Escape"&&isOpen())setOpen(false)});
  all(".dv2-concierge__suggestion",cpanel).forEach(function(btn){
    btn.addEventListener("click",function(){
      var topic=btn.getAttribute("data-dv2-topic");
      if(!topic||answered[topic])return;
      var entry=null;
      for(var i=0;i<entries.length;i++){if(entries[i].topic===topic){entry=entries[i];break}}
      if(!entry)return;
      answered[topic]=true;
      btn.setAttribute("disabled","disabled");
      add("q",entry.question);
      add("a",entry.answer);
    });
  });
  cpanel.addEventListener("keydown",function(e){
    if(e.key==="Escape"){setOpen(false);return}
    if(e.key!=="Tab")return;
    var f=focusables();if(!f.length)return;
    var first=f[0],last=f[f.length-1];
    if(e.shiftKey&&d.activeElement===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&d.activeElement===last){e.preventDefault();first.focus()}
  });
}
})();`;
}
