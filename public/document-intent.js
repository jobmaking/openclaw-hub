'use strict';
(function attach(root){
  const tidy=s=>s.trim().replace(/^[«“"']|[»”"']$/gu,'').trim();
  const target='(?:el\\s+|la\\s+)?(?:(?:nuevo sistema|sistema nuevo)(?: de documentos)?|(?:nuevo |nueva )?(?:sistema|panel|editor|funci[oó]n|funcionalidad) de documentos|(?:HUB )?Documentos)';
  const directLead=/^(?:¿\s*)?(?:por favor[,: ]+)?(?:(?:puedes|podr[ií]as)\s+|(?:quiero|necesito)\s+que\s+)?/iu;
  const copy=new RegExp('^(?:p[aá]sa(?:me)?(?:lo|la)?|pases|pasar|pon(?:lo|la)?|pongas|ll[eé]va(?:lo|la)?|lleves|copia(?:lo|la)?|copies|transfiere(?:lo|la)?)\\s+(?:(?:esto|eso|lo|la|lo anterior|(?:tu|la) (?:[úu]ltima )?respuesta|el texto|el borrador)\\s+)?(?:a|al|en|dentro de)\\s+'+target+'[.!?]*$','iu');
  const use=new RegExp('^(?:usa|uses|usar|utiliza|utilices|utilizar|hazlo|h[aá]zlo|hagas|ponlo)\\s+(?:en\\s+)?'+target+'(?:[,:;.!?]*$|\\s+(?:para|y)\\s+([\\s\\S]+))','iu');
  const produce=/^(?:prep[aá]ra(?:me)?|preparas|prepares|preparar|crea(?:me)?|crees|crear|redacta(?:me)?|redactes|redactar|haz(?:me)?|hagas|hacer|escr[ií]be(?:me)?|escribas|escribir|g[eé]nera(?:me)?|generes|generar|elabora(?:me)?|elabores|elaborar)\s+([\s\S]+)/iu;
  const toTarget=new RegExp('(?:^|\\s)(?:en|dentro de|para)\\s+'+target+'(?!\\s+(?:adjuntos?|legales?|internos?|pdf|de\\s+(?:referencia|terceros))\\b)(?=\\s|[.!?,:;]|$)','iu');
  const external=/(?:\b(?:env[ií]a|manda|publica|sube|comparte)[\p{L}]*\b.{0,80})?(?:\b(?:por|v[ií]a|en) (?:WhatsApp|Signal|Telegram|correo|e-?mail|Slack|Teams|Google Docs)\b|https?:\/\/|www\.)/iu;
  function parse(text){
    if(typeof text!=='string'||text.length>4200||!text.trim())return null;
    const value=text.trim();
    const explicit=value.match(/^\/documentos?\s+(abrir|crear|pasar)(?:\s+([\s\S]+))?$/iu);
    if(explicit){
      const kind=explicit[1].toLowerCase(), query=tidy(explicit[2]||'');
      if(kind==='pasar')return query?null:{kind:'copy',query:''};
      return query?{kind:kind==='abrir'?'open':'draft',query}:null;
    }
    const command=value.replace(directLead,'').replace(/[, ]+por favor[.!?]*$/iu,'')
      .replace(/^(lo|la|esto|eso)\s+(pongas|pases|lleves|copies)\s+/iu,'$2 $1 ')
      .replace(/^lo hagas\s+/iu,'hazlo ');
    if(!command||/^(?:no\b|[«“"'\x60>#]|c[oó]mo\b|qu[eé]\b|d[oó]nde\b|por qu[eé]\b)/iu.test(command))return null;
    const requestUse=command.match(use);
    if(!external.test(command)){
      if(copy.test(command))return {kind:'copy',query:''};
      if(requestUse && !requestUse[1])return {kind:'choose',query:''};
      if(requestUse?.[1] && produce.test(requestUse[1].trim()))return {kind:'draft',query:tidy(requestUse[1])};
    }
    const opening=command.match(/^(?:[áa]breme|abre|abrir|abras|mu[eé]strame|muestres)\s+(?:(?:el|la|un|una|mi)\s+)?(?:(?:documento|borrador)\s+(?:de\s+)?(?:t[ií]tulo\s+)?)?([^\n]+)$/iu);
    if(opening&&(/^(?:[áa]breme|mu[eé]strame)\s/iu.test(command)||/\b(?:documento|borrador|Documentos)\b/iu.test(command)) && !/https?:|www\.|\/|\.[a-z0-9]{2,5}(?:\s|[!?]|$)/iu.test(opening[1])){
      const name=tidy(opening[1].replace(new RegExp('\\s+en\\s+'+target+'[.!?]*$','iu'),'').replace(/[.!?]+$/u,''));
      if(name && !/^(?:el )?(?:sistema nuevo|nuevo sistema|(?:hub )?documentos?|editor de documentos)$/iu.test(name) && !/^qu[eé]\b/iu.test(name))return {kind:'open',query:name};
      return null;
    }
    // Only an imperative with an explicit destination becomes a new draft. Reading, discussion
    // and ordinary writing requests stay in chat. Preserve substantial instructions verbatim.
    if(!external.test(command)){
      const tail=command.match(produce)?.[1];
      const ending=tail?.match(new RegExp('\\s+(?:(?:y\\s+)?(?:usa|utiliza)|usando|utilizando)\\s+'+target+'[.!?]*$','iu'));
      const location=ending||tail?.match(toTarget);
      if(location){
        const brief=tidy(tail.slice(0,location.index)+tail.slice(location.index+location[0].length).replace(/^[.,;:!?\s]+/u,'\n')).trim();
        if(brief)return {kind:'draft',query:brief};
        return {kind:'choose',query:''};
      }
    }
    return null;
  }
  function titleKey(s){return s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim().replace(/^(?:el|la|un|una|del) /u,'');}
  const api=Object.freeze({parse,titleKey});
  if(typeof module==='object'&&module?.exports)module.exports=api;
  else if(root)root.HubDocumentIntent=api;
})(typeof window==='object'?window:null);
