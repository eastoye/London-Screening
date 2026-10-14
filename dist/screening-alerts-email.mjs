const API='https://czsknzrtumbdweusfyhk.supabase.co/functions/v1/screening-alerts-email-links';
const values=new URLSearchParams(location.hash.slice(1));
// Keep tokens out of referrers, history and visible UI. Never persist them.
history.replaceState(null,'',location.pathname);
const purpose=values.get('purpose'),token=values.get('token');
const id=values.get(purpose==='confirm'?'challenge':'delivery');
const title=document.getElementById('title'),description=document.getElementById('description');
const button=document.getElementById('confirm'),status=document.getElementById('status');
if(!['confirm','unsubscribe'].includes(purpose)||! /^[0-9a-f]{64}$/.test(token??'')||! /^[0-9a-f-]{36}$/i.test(id??'')){
 description.textContent='This link is invalid. Open the complete link from your email.';
}else{
 const confirm=purpose==='confirm';
 title.textContent=confirm?'Confirm screening alerts':'Unsubscribe from screening alerts';
 description.textContent=confirm?'Confirm that you want morning emails about newly added London screenings for films you follow. You can unsubscribe at any time.':'Stop screening-alert emails to this address.';
 button.textContent=confirm?'Confirm email alerts':'Unsubscribe';button.hidden=false;
 button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='Please wait…';
  try{
   const response=await fetch(API,{method:'POST',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({action:purpose,token,[confirm?'challenge':'delivery']:id}),signal:AbortSignal.timeout(15000)});
   const result=await response.json();
   if(!response.ok||result[confirm?'confirmed':'unsubscribed']!==true)throw new Error('Invalid or expired link.');
   status.textContent=confirm?'Your email is confirmed. Alerts will include qualifying screenings added after this confirmation.':'You have unsubscribed from screening alerts.';
   button.hidden=true;
  }catch{status.textContent='We could not complete this request. The link may have expired or already been used. Try again or request a fresh confirmation from your account.';button.disabled=false;}
 },{once:false});
}
