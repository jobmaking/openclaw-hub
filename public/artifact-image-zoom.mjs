// Coordinates are relative to the viewer, never to the page or its visual scale.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function imageZoom(stage, image, region, controls, signal, button) {
  let width=0, height=0, baseW=0, baseH=0, x=0, y=0, scale=1;
  let frame=0, announcement=0, gesture=null, webkitStart=null;
  const pointers=new Map(), cap=6;
  const step=1.35;
  const minus=button('−','Reducir imagen',()=>zoomAt(scale/step));
  const plus=button('+','Ampliar imagen',()=>zoomAt(scale*step));
  const fit=button('Ajustar','Ajustar imagen',()=>zoomAt(1));
  const group=document.createElement('div');group.className='av-group av-image-tools';
  group.setAttribute('role','group');group.setAttribute('aria-label','Zoom de la imagen');
  const percentage=document.createElement('span');percentage.className='av-position';percentage.setAttribute('aria-hidden','true');
  const live=document.createElement('span');live.className='av-image-announcement';live.setAttribute('role','status');
  group.append(minus,percentage,plus,fit,live);controls.append(group);controls.hidden=false;
  stage.classList.add('av-image-stage');
  region.setAttribute('aria-description','Usa + y − para cambiar el zoom, 0 para ajustar y las flechas para mover la imagen ampliada.');

  function constrain() {
    const horizontal=baseW*scale, vertical=baseH*scale;
    x=horizontal<=width?(width-horizontal)/2:clamp(x,width-horizontal,0);
    y=vertical<=height?(height-vertical)/2:clamp(y,height-vertical,0);
  }
  function update() {
    constrain();
    if(frame)return;
    frame=requestAnimationFrame(()=>{
      frame=0;
      image.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';
      stage.classList.toggle('av-image-pannable',scale>1.0001);
      const label=Math.round(scale*100)+'%';
      if(percentage.textContent!==label){
        percentage.textContent=label;clearTimeout(announcement);
        announcement=setTimeout(()=>{live.textContent='Ampliación: '+label;},220);
      }
      const marker=(node, disabled)=>{
        const value=String(disabled);
        if(node.getAttribute('aria-disabled')!==value)node.setAttribute('aria-disabled',value);
      };
      marker(minus,scale<=1.0001);marker(fit,scale<=1.0001);marker(plus,scale>=cap-0.0001);
    });
  }
  function local(clientX,clientY) {
    const rect=stage.getBoundingClientRect();
    return {x:clientX-rect.left,y:clientY-rect.top};
  }
  function zoomAt(next, point={x:width/2,y:height/2}) {
    const factor=clamp(next,1,cap);
    if(factor===scale)return;
    const ratio=factor/scale;scale=factor;
    x=point.x-(point.x-x)*ratio;y=point.y-(point.y-y)*ratio;
    update();
  }
  function measure() {
    const w=stage.clientWidth,h=stage.clientHeight;
    if(w<=0||h<=0||w===width&&h===height)return;
    const u=baseW?(width/2-x)/(baseW*scale):.5,v=baseH?(height/2-y)/(baseH*scale):.5;
    width=w;height=h;
    const pad=Math.min(12,width/20,height/20);
    const fitted=Math.min((width-2*pad)/image.naturalWidth,(height-2*pad)/image.naturalHeight);
    baseW=image.naturalWidth*fitted;baseH=image.naturalHeight*fitted;
    image.style.width=baseW+'px';image.style.height=baseH+'px';
    x=width/2-u*baseW*scale;y=height/2-v*baseH*scale;
    update();rebase();
  }
  function pose() {
    const [a,b]=pointers.values();if(!a)return null;
    return b?{x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(8,Math.hypot(a.x-b.x,a.y-b.y))}:{...a,distance:0};
  }
  function rebase() {
    const p=pose();
    gesture=p?{p,anchor:local(p.x,p.y),x,y,scale}:null;
  }
  const listen=(target,name,fn,options={})=>target.addEventListener(name,fn,{...options,signal});
  listen(stage,'pointerdown',event=>{
    if(event.pointerType==='mouse'&&event.button!==0||pointers.has(event.pointerId)||pointers.size>=2)return;
    event.preventDefault();
    if(event.pointerType==='mouse')region.focus({preventScroll:true});
    webkitStart=null;
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    rebase();stage.classList.toggle('av-image-dragging',scale>1.0001);
  });
  listen(stage,'pointermove',event=>{
    if(!gesture||!pointers.has(event.pointerId))return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const now=pose(), before=gesture;
    scale=now.distance?clamp(before.scale*now.distance/before.p.distance,1,cap):before.scale;
    const ratio=scale/before.scale;
    x=before.anchor.x-(before.anchor.x-before.x)*ratio+now.x-before.p.x;
    y=before.anchor.y-(before.anchor.y-before.y)*ratio+now.y-before.p.y;
    update();
  });
  function end(event) {
    if(!pointers.delete(event.pointerId))return;
    rebase();if(!pointers.size)stage.classList.remove('av-image-dragging');
  }
  for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(stage,type,end);
  listen(stage,'wheel',event=>{
    if(event.cancelable)event.preventDefault();
    if(!event.deltaY)return;
    const unit=event.deltaMode===2?height:event.deltaMode===1?16:1;
    zoomAt(scale*Math.exp(clamp(-event.deltaY*unit*.003,-.35,.35)),local(event.clientX,event.clientY));
    rebase();
  },{passive:false});
  // Safari desktop can send GestureEvents instead of Ctrl+wheel. Do not also
  // apply them when touch pointers already own the same gesture.
  listen(stage,'gesturestart',event=>{
    if(event.cancelable)event.preventDefault();
    webkitStart=pointers.size?null:scale;
  },{passive:false});
  listen(stage,'gesturechange',event=>{
    if(event.cancelable)event.preventDefault();
    if(webkitStart===null||pointers.size||!Number.isFinite(event.scale))return;
    const anchor=Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?local(event.clientX,event.clientY):undefined;
    zoomAt(webkitStart*event.scale,anchor);
  },{passive:false});
  listen(stage,'gestureend',()=>{webkitStart=null;});
  listen(stage,'dblclick',event=>{
    event.preventDefault();zoomAt(scale>1.0001?1:2.5,local(event.clientX,event.clientY));
  });
  listen(region,'keydown',event=>{
    if(event.target!==region||event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return;
    switch(event.key){
      case '+':case '=':zoomAt(scale*step);break;
      case '-':zoomAt(scale/step);break;
      case '0':zoomAt(1);break;
      case 'ArrowLeft':x+=48;update();break;
      case 'ArrowRight':x-=48;update();break;
      case 'ArrowUp':y+=48;update();break;
      case 'ArrowDown':y-=48;update();break;
      default:return;
    }
    event.preventDefault();rebase();
  });
  const size=new ResizeObserver(measure);size.observe(stage);measure();
  signal.addEventListener('abort',()=>{
    size.disconnect();cancelAnimationFrame(frame);clearTimeout(announcement);
    for(const id of pointers.keys())if(stage.hasPointerCapture(id))stage.releasePointerCapture(id);
    pointers.clear();region.removeAttribute('aria-description');group.remove();controls.hidden=true;
  },{once:true});
}
