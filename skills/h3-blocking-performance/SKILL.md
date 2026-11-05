---
name: h3-blocking-performance
description: 用三层空间协议锁多人站位、用上一镜头截图当站位图、按话轮与生理泄露写表演，修掉 AI 视频里换位、越轴、排队朗读和脸假的问题
whenToUse: 当 AI 视频出现人物换位/穿帮、两个镜头接不上、对白像排队朗读、表情只有结果没有过程，或要写多人同框的分镜提示词时
---

# AI 视频的人物站位、镜头衔接与表演

来源（每条规则后面有回跳链接）：
- [好莱坞群像控场法·三锁控场法](https://www.bilibili.com/video/BV1XggH63EeM)｜Foyege弗曳哥｜6 分钟
- [好莱坞终极控场法·三层空间协议](https://www.bilibili.com/video/BV1Tn836WEmb)｜Foyege弗曳哥｜6 分钟
- [AI 短剧的人物站位和镜头衔接](https://www.bilibili.com/video/BV1wDMk6mEVd)｜爱收藏的蚂蚁｜35 分钟
- [最新表演 skill 分享](https://www.bilibili.com/video/BV1sLtm61Egx)｜灰渡丨Simon｜5 分钟
- [释放 AI 演技的提示词公式：表情、台词、停顿、抢话](https://www.bilibili.com/video/BV1jLug6LEgp)｜Foyege弗曳哥｜6 分钟

另有《最后一把伞》H3 本地渲染 v1→v5 的实测，标 **实测** 的条目来自那里，不是教程原话。

分工：`minimax-h3-prompt` 管字段格式，`h3-realism-camera` 管运镜选择与去 AI 味，`music-video-pipeline` 管时间轴与拼接，**本技能只管站位、衔接与表演**。

## 1. 三层空间协议（站位）

同一件空间事实只允许写在一层，混层会让模型重新分配位置。

1. **L1 世界拓扑**（全片一次）：俯视描述固定关系——门在哪、架子在哪、人行道在哪。
   [00:48](https://www.bilibili.com/video/BV1Tn836WEmb?t=48)「三层空间协议」·[00:56](https://www.bilibili.com/video/BV1Tn836WEmb?t=56)「底层是俯视图的世界拓扑」
2. **L2 角色资产映射**（全片一次）：`<Subject 1>`=谁、`<Subject 2>`=谁，只绑编号与五官发型服装，**这一层不写左右深处**。
   [01:20](https://www.bilibili.com/video/BV1Tn836WEmb?t=80)「不要在这一层重新写左下角」·[01:40](https://www.bilibili.com/video/BV1Tn836WEmb?t=100)「事实混进了三套不同的参照系」·[01:51](https://www.bilibili.com/video/BV1Tn836WEmb?t=111)「模型就会收到重复甚至互相冲突的空间条件」
3. **L3 逐秒时间码**（每镜只写当前镜头）：构图、动作、朝向、说话。群像镜头**别把整屋重述一遍**。
   [04:49](https://www.bilibili.com/video/BV1XggH63EeM?t=289)「又把所有人的位置重新描述一遍」·[04:52](https://www.bilibili.com/video/BV1XggH63EeM?t=292)「模型反而开始重新分配空间」·[05:00](https://www.bilibili.com/video/BV1XggH63EeM?t=300)「后面的时间码只需要写当前镜头拍到哪里」

**每镜开头第一秒交代人物在画面左右**——文字权重可能高于参考图。
[08:48](https://www.bilibili.com/video/BV1wDMk6mEVd?t=528)「每个镜头之前都要写一个人物站位」·[08:51](https://www.bilibili.com/video/BV1wDMk6mEVd?t=531)「把开头第一秒的人物位置交代清楚」·[08:10](https://www.bilibili.com/video/BV1wDMk6mEVd?t=490)「可能会高于你图片的权重」

**出错按层排查，别靠加字数**：前 3 秒就错→查 L1；镜头一动就乱→查 L3 路线；朝向错→补视线。
[04:29](https://www.bilibili.com/video/BV1Tn836WEmb?t=269)·[04:47](https://www.bilibili.com/video/BV1Tn836WEmb?t=287)·[04:56](https://www.bilibili.com/video/BV1Tn836WEmb?t=296)

## 2. 站位图链（截图接力）

1. **首镜必须是带人物的全景**，给后面所有镜头统一参照。
   [17:22](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1042)「一进来就看到谁和谁坐在哪个地方」·[17:44](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1064)「方便你后面的人物不串帮」
2. **后续镜头拿上一镜头截图当场景参考**，站位、坐姿、服装才接得上（双层锁死）。
   [14:56](https://www.bilibili.com/video/BV1wDMk6mEVd?t=896)「采用它的截图当做下一个镜头的参考图」·[15:08](https://www.bilibili.com/video/BV1wDMk6mEVd?t=908)「所有人物的坐姿站位全都是正常的」·[31:21](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1881)「相当于双层锁死了这几个人的站位」
3. **但上一镜尾帧 ≠ 下一镜首帧**，同画面会跳帧；截图只当站位图，下一镜另写首帧描述。
   [18:54](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1134)「同一个画面镜头 它会有跳帧」·[22:41](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1361)「坚决不能让两个帧是完全一样的画面」
4. **参考图里有什么，模型就给你什么**（实测）：含伞架的全景图喂给「他拿一把伞」→ 手里变一捆；含两人的全景图喂给手部特写 → 死守全景构图、把手臂放大贴到前景。特写与单人镜头要**换掉全景站位图**，改用不含干扰物的场景图或该区域裁切图。
   实测：v2 clip03/06 手部特写崩 → 换场景设定图后 v3 修好；v3 clip07 一捆伞 → 换不含伞架的街侧裁切图后 v5 变一支。

## 3. 衔接

- **情绪也要衔接**：下一镜开头延续上一镜的表情。
  [19:54](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1194)「不光是位置衔接 人物的情绪也要衔接」
- **两个脸部特写之间必须插动作/手部特写**。
  [33:24](https://www.bilibili.com/video/BV1wDMk6mEVd?t=2004)「直接是两个人的脸部特写」·[33:29](https://www.bilibili.com/video/BV1wDMk6mEVd?t=2009)「这样的镜头连接就是不舒服的」·[32:51](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1971)「直接切手中的这个药物特写」
- **一镜只处理一次主要变化**，4–8 秒最稳；复杂走位、大幅运镜、多动作别塞同一镜。
  [03:41](https://www.bilibili.com/video/BV1sLtm61Egx?t=221)「更适合 4~8 秒」·[03:46](https://www.bilibili.com/video/BV1sLtm61Egx?t=226)「一个镜头最好只处理一次主要变化」
- **不想出现的东西别写进提示词**（写「伤口」就长出伤口；同理否定词等于注入概念）。
  [24:27](https://www.bilibili.com/video/BV1wDMk6mEVd?t=1467)「AI 就会真的把这伤口从衣服上给你生成出来」
- **小 bug 让位于大逻辑**：左右手不一致这类先放过。
  [34:38](https://www.bilibili.com/video/BV1wDMk6mEVd?t=2078)「有时候为了大的逻辑」

## 4. 表演：写触发、动机、过程

- **别只写情绪结果**，模型不知道人为什么悲伤。
  [00:55](https://www.bilibili.com/video/BV1sLtm61Egx?t=55)「不知道人物为什么悲伤」·[01:03](https://www.bilibili.com/video/BV1sLtm61Egx?t=63)「没有动机和过程」
- **悲伤公式 = 生理泄露 + 自我控制 + 关系目标**：眼眶泛红、吞咽、喉部滚动 → 移开视线、盯着手里的东西 → 把伞推过去。高级的悲伤是**表情受阻力**。
  [03:25](https://www.bilibili.com/video/BV1jLug6LEgp?t=205)「生理泄露加自我控制加关系目标」·[03:34](https://www.bilibili.com/video/BV1jLug6LEgp?t=214)「眼眶周围轻微泛红」·[04:05](https://www.bilibili.com/video/BV1jLug6LEgp?t=245)「高级的悲伤从来不是增加表情 而是让表情受到阻力」
- **拆到眉毛、眼睛、嘴部、呼吸的粒度**，肩膀随呼吸起伏。
  [02:41](https://www.bilibili.com/video/BV1Lw4169ENi?t=161)「比如说眉毛」·[02:45](https://www.bilibili.com/video/BV1Lw4169ENi?t=165)「肩膀和呼吸要产生轻微的起伏」

## 5. 对白：设计话轮，不是排列台词

- **真实对话有抢话、停顿、改口**，秩序感太强像排队朗读。
  [00:56](https://www.bilibili.com/video/BV1jLug6LEgp?t=56)「他们根本不是在对话 只是在排队朗读」·[01:08](https://www.bilibili.com/video/BV1jLug6LEgp?t=68)「被情绪击中以后 往往说不完一句完整的话」·[01:49](https://www.bilibili.com/video/BV1jLug6LEgp?t=109)「两个人的声音重叠约 0.2 秒」
- **不流畅要对应情绪**：羞耻内疚→启动失败、口吃；急于自证→重复加重复重音；突然听懂残酷的事→沉默加吸气。
  [02:42](https://www.bilibili.com/video/BV1jLug6LEgp?t=162)·[02:46](https://www.bilibili.com/video/BV1jLug6LEgp?t=166)·[02:50](https://www.bilibili.com/video/BV1jLug6LEgp?t=170)
- **实测：把对方台词写成画外重叠，模型会让她入画并把字幕烧进画面**。一镜只留一个说话人、一句话，后半句交给下一镜的沉默。
  实测：v4 clip07 出现烧录字幕「你先用」→ v5 改单人单句后消失。

## 6. 提交前自检

- [ ] 首镜是带人物全景？
- [ ] L1 拓扑全片只写一次，没在每镜重述？
- [ ] 每镜第一秒写清人物在画面左右？
- [ ] 后续镜头的场景参考 = 上一镜截图，且不含该镜不需要的物体？
- [ ] 没有「脸部特写直接切脸部特写」？
- [ ] 每镜只有一次主要变化（时间码数 ≤ 时长/4）？
- [ ] 表演镜头有生理词（喉/吞咽/呼吸/下颌/视线）？
- [ ] 对白只有一个说话人，或有明确话轮与重叠？
- [ ] 全片没有否定词、没有变焦词？
