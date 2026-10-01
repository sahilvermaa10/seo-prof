def calculate_score(data):
    score=100; issues=[]; passed=[]
    def issue(priority,title,detail,impact):
        nonlocal score
        score=max(0,score-impact)
        issues.append({"priority":priority,"title":title,"detail":detail,"impact":impact})
    title=data.get("title",""); tl=len(title)
    if not title: issue("critical","Missing title tag","Add a unique, descriptive title.",15)
    elif tl<30 or tl>60: issue("warning","Title length needs attention",f"Current length: {tl}. Aim roughly for 30–60 characters.",5)
    else: passed.append("Title length is in a healthy range")
    desc=data.get("meta_description",""); dl=len(desc)
    if not desc: issue("critical","Missing meta description","Add a unique meta description.",15)
    elif dl<70 or dl>170: issue("warning","Meta description length needs attention",f"Current length: {dl}. Aim roughly for 70–170 characters.",5)
    else: passed.append("Meta description is present")
    h1=data.get("h1_count",0)
    if h1==0: issue("critical","Missing H1","Add one clear primary H1 heading.",10)
    elif h1>1: issue("warning","Multiple H1 headings",f"Found {h1} H1 elements. Usually one primary H1 is clearer.",4)
    else: passed.append("Exactly one H1 found")
    if not data.get("canonical"): issue("warning","Missing canonical URL","Add a canonical link element to clarify the preferred URL.",5)
    else: passed.append("Canonical URL found")
    missing=data.get("images_without_alt",0)
    if missing: issue("warning","Images missing ALT text",f"{missing} images are missing ALT text.",min(10,missing*2))
    if data.get("word_count",0)<300: issue("warning","Potentially thin content",f"Only {data.get('word_count',0)} visible words were detected.",5)
    if data.get("viewport"): passed.append("Mobile viewport tag found")
    else: issue("warning","Missing mobile viewport","Add a responsive viewport meta tag.",5)
    if data.get("status_code",200)>=400: issue("critical","Page returned an error status",f"HTTP {data.get('status_code')}",20)
    return {"score":score,"issues":issues,"passed":passed,"critical":sum(x['priority']=='critical' for x in issues),"warnings":sum(x['priority']=='warning' for x in issues)}
