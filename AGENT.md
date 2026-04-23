# AGENT.md

本文件面向在本仓库中工作的 agent / 自动化代码生成器。

目标：

1. 快速理解项目结构。
2. 知道新增代码应该放在哪一层。
3. 避免绕过现有中间层，造成未来切换数据源或重构时失控。
4. 统一组件、第三方库、API、状态管理的使用方式。

## 1. 项目概览

这是一个基于 Next.js App Router 的应用，主要技术栈：

- React 19
- Next.js 16
- TypeScript
- Mantine 9
- Tailwind CSS 4
- TanStack Query
- Zod
- Supabase SSR
- ky

当前项目已经形成了比较明确的分层：

- `src/app`：页面、layout、route handler、API route type schema
- `src/components`：跨页面复用的通用组件
- `src/config`：全局配置、内容配置、主题配置、通知配置、导航配置
- `src/hooks`：可复用的轻量客户端 hook
- `src/lib`：领域逻辑、repository、HTTP、Supabase、媒体工具、通知、replay
- `src/modals`：Mantine modal registry 组件
- `src/providers`：全局 provider
- `src/querys`：React Query hooks
- `src/stores`：轻量客户端状态 / context state
- `src/styles`：全局样式入口
- `src/types`：通用业务类型
- `src/utils`：纯函数工具

## 2. 顶层目录约定

### 2.1 页面与路由

- 页面放在 `src/app/**`
- API route 放在 `src/app/api/**`
- 认证后页面放在 `src/app/(authenticated)/**`
- 未认证页面放在 `src/app/(unauthenticated)/**`

新增页面时：

- 如果是具体业务页面的私有组件，放到该页面目录下的 `_components`
- 如果组件会被多个页面复用，放到 `src/components`

### 2.1.1 Admin 页面边界

admin 与普通用户页面必须严格隔离。

这是一个强约束，不是偏好项。

当前约定：

- 用户页面放在 `src/app/(authenticated)/(home)/**`
- admin 页面放在 `src/app/(authenticated)/(admin)/**`

新增 admin 功能时：

- 新页面、新 layout、新私有组件都放在 `(admin)` route group 内
- 不要把 admin 页面继续塞回 `(home)`，也不要在用户 route group 内混入 admin 私有状态逻辑
- admin 页面可以复用共享的底层能力，例如 `src/lib/**`、`src/querys/**`、`src/modals/**`
- 但不要直接复用用户页面私有组件，例如 `(home)` 下的 `_components`
- 如果 admin 页面需要一套相似但职责不同的 UI，应在 `(admin)` 内重新实现，而不是在用户组件里不断加 `isAdmin` 分支

隔离原则：

- 不要在用户页面组件中混入 admin 页面逻辑
- 不要在 admin 页面组件中混入用户页面特例逻辑
- 能通过“新增一个 admin 组件”解决的问题，不要通过“给用户组件加一个 admin prop / isAdmin 分支”解决
- 能通过 route group 隔离的问题，不要继续在同一个页面里做角色分支
- 如果一个组件已经明显变成“用户版”和“admin 版”两套语义，立即拆开，不继续维持单组件双语义

组件复用边界：

- 可以复用：真正通用的基础组件，例如 `src/components/**` 中不带页面语义的组件
- 可以复用：共享数据层、query hooks、repository、modals、config
- 不可以复用：用户页面私有 `_components`
- 不可以复用：admin 页面私有 `_components`
- 不可以复用：已经携带明确角色语义的页面组合组件，例如用户项目列表页组件链不应直接作为 admin project management 页面使用

条件分支约定：

- `user.isAdmin` 这类角色判断优先放在 route、layout、导航配置过滤、或独立入口组件中
- 不要把 `user.isAdmin` 扩散到大量展示组件里
- 如果某段 UI 只有 admin 会看到，优先新建 admin 专属组件，而不是在用户组件内部做条件渲染
- 用户页允许保留“进入 admin 的入口”这一类薄条件分支，但不要把 admin 业务展示、admin 表格、admin 操作菜单继续留在用户页组件中

导航约定：

- `src/config/menu-config.ts` 是用户与 admin 共用的一份导航配置来源
- 普通用户不能看到 admin section
- admin shell 可以展示完整导航，但仍应使用自己的 navbar/header 组件，不要直接复用用户壳层组件

项目管理页约定：

- admin project management 不应依赖用户侧 `ProjectsList` 那套页面语义组件链
- admin 列表、card、loading、error 优先在 `(admin)/project-management/_components/**` 内自建
- 用户项目页的交互调整，不应该顺手把 admin project management 一起改乱；反之亦然

### 2.2 通用组件

放在 `src/components/**`

适合放这里的内容：

- `ProjectsList`
- `FeedCard`
- `Logo`
- `LinkButton`
- `UserAvatarMenu`

放置规则：

- 一个通用组件一个目录，主文件名与导出名保持一致
- 跨页面复用的组件目录可以带 `index.ts` barrel
- 优先放无路由语义、无角色语义、无页面私有状态机的组件
- 允许存在轻量数据感知包装组件，例如 `ProjectsListQuery`、`ProfileCredits`，但它们只能依赖共享 `src/querys/**` hook

禁止：

- 不要把强业务语义、强路由耦合组件放到 `src/components`
- 不要把 `(home)`、`(admin)`、`project/[projectId]` 私有组合组件提升到 `src/components`

### 2.3 前端优化目录职责

以下目录已经完成收敛。新增功能和后续重构必须优先遵循这些边界，而不是重新发散到页面目录或 `lib` 里。

#### `src/config`

职责：

- 存放全局配置、导航配置、通知配置、Mantine 主题配置、站点内容配置
- 作为“配置表”或“映射表”的唯一来源

规范：

- 配置必须保持静态、纯粹、可直接 import
- 不要在 `config` 中写请求、副作用、浏览器 API、React hook
- 内容/运营导向配置对象允许统一使用 `snake_case`
- 同一配置对象内部不要混用 `camelCase` 和 `snake_case`

#### `src/hooks`

职责：

- 存放可复用的轻量客户端行为 hook，例如时间刷新、占位符动画等 UI 行为封装

规范：

- 文件名统一 `use-*.ts` 或 `use-*.tsx`
- hook 应聚焦单一职责，避免承载复杂业务流程
- 不要把远程请求放进 `src/hooks`，远程请求统一放 `src/querys`
- 不要把页面级复杂状态机放进 `src/hooks`，复杂局部编排优先页面级 provider
- 导出的 hook 优先补充 JSDoc，写清楚参数、刷新策略、边界行为

#### `src/modals`

职责：

- 存放 Mantine modal registry 下的全部弹窗组件和打开入口

规范：

- 一个 modal 一个目录
- 目录内优先保持 3 个文件：主 modal 组件、`open-*.ts` 打开方法、`index.ts`
- 所有 modal 都必须通过 `src/providers/ModalProvider.tsx` 注册
- modal 内允许持有本地表单状态和本地交互错误
- modal 涉及远程请求时，只能消费 `src/querys/**` 暴露的 hook

禁止：

- 不要在页面或组件里临时挂载新的 `ModalsProvider`
- 不要在 modal 里直接调用 `requestApiData`

#### `src/providers`

职责：

- 存放应用级 provider 组合与基础设施 provider

当前约定：

- `AppProvider` 负责整体组合 Mantine / Query / Modal / Notifications
- `QueryProvider` 只负责 QueryClient 和默认策略
- `ModalProvider` 只负责 modal registry

规范：

- `src/providers` 只放全局级 provider，不放页面私有业务状态机
- 页面复杂状态编排应留在页面目录，例如 `ProjectConversationProvider.tsx`
- provider 自身应尽量薄，只做上下文注入和基础配置，不承载大量业务逻辑

#### `src/stores`

职责：

- 存放跨页面共享、但仍然是轻量级的客户端 context state

规范：

- 当前仓库的 store 实现优先使用 React Context，不要引入新的全局状态方案
- store 不负责远程数据缓存，远程数据仍然走 React Query
- store 不负责复杂业务流程编排，复杂流程应交给 provider / lib / repository
- 需要强约束的 store hook 应在 context 缺失时直接抛错，例如认证用户上下文

#### `src/styles`

职责：

- 存放全局样式入口和真正全局级的样式规则

规范：

- 当前全局样式入口是 `src/styles/index.css`
- 主题 token 和 Mantine 组件主题覆盖优先放 `src/config/mantine-config.ts`
- `styles` 只放全局 reset、全局 CSS 变量、全局基础样式
- 不要把单组件样式文件堆进 `src/styles`

#### `src/utils`

职责：

- 存放与 React、路由、请求无关的纯函数工具

规范：

- 优先保持纯函数、确定性、无副作用
- 不要在 `utils` 中访问 DOM、window、storage、request client
- 不要把业务编排、repository 访问、通知逻辑放到 `utils`
- 导出的工具函数优先补充 JSDoc

### 2.4 领域逻辑

放在 `src/lib/**`

典型例子：

- `src/lib/data/*-repository.ts`
- `src/lib/http/*`
- `src/lib/media/*`
- `src/lib/replay/*`
- `src/lib/supabase/*`
- `src/lib/notifications/*`

原则：

- 业务逻辑优先放 `lib`
- UI 组件不要直接拼接复杂业务数据
- API route 不要直接持有复杂业务逻辑

## 3. 新增功能时的落点规则

这是最重要的部分。新增功能时，先判断属于哪一层。

### 3.1 新增页面功能

如果是一个页面内私有功能：

- 页面文件：`src/app/.../page.tsx`
- 私有组件：`src/app/.../_components/*`

如果这个功能会在多个页面共享：

- 通用 UI 放 `src/components`
- 通用逻辑放 `src/lib`

### 3.2 新增 API

新增 API 必须同时补三层：

1. `src/app/api/.../route.ts`
2. `src/app/api/types/...`
3. `src/lib/data/...-repository.ts` 或对应领域的 `src/lib/*`

推荐顺序：

1. 先定义 Zod schema 和类型
2. 再写 repository
3. 最后写 route handler

不要直接在 route handler 里：

- 写复杂持久化细节
- 做大量业务状态推导

### 3.3 新增客户端数据请求

优先使用：

- `src/querys/*`：统一管理的 query / mutation hook

当前要求：

- 所有客户端远程请求都必须收敛到 `src/querys`
- 不要在 page / provider / component / modal 中直接写 `useQuery` / `useMutation`
- 不要在 page / provider / component / modal 中直接调用 `requestApiData`
- 页面层只能消费 `src/querys` 暴露出来的 hook

判断标准：

- query / mutation 本身：`src/querys`
- 页面级 provider 可以编排状态机、副作用和本地 UI 状态，但远程请求仍然从 `src/querys` 注入

### 3.4 Mock 规则

不要放回页面目录里的 `data.ts`。

当前项目已进入正式研发完成状态。

约束如下：

- 本地运行时代码不再保留 mock 数据源
- 页面、组件、provider、query、repository、route handler 都不应再新增 mock 分支
- 运行时 `src/lib/**` 里允许存在真实业务 helper，例如 replay / adapter，但它们不是 mock

原则：

- mock 不是运行时数据源
- UI 只能消费 provider / query / API 返回的数据

## 4. 当前推荐的数据流

推荐的数据流是：

UI Component
-> page/provider/query hook
-> `requestApiData`
-> API route
-> repository / lib 业务逻辑
-> 数据源 / Supabase / 外部服务

不要绕过这条链路。

尤其不要：

- 组件直接 import mock 数据
- 组件直接调用底层数据源
- 组件直接拼 API response shape
- API route 直接返回未经 schema 约束的任意对象

## 5. API 设计规范

### 5.1 响应格式

统一使用：

- `createApiSuccessResponse`
- `createApiErrorResponse`
- `createApiResponseInit`

定义在：

- `src/lib/http/api-response.ts`

客户端统一通过：

- `requestApiData`

定义在：

- `src/lib/http/request-api.ts`

新增 API 时：

- 必须配套 Zod schema
- 客户端必须用 schema 校验响应
- 业务错误必须返回稳定结构，不要只返回裸文本
- HTTP status 负责表达协议层状态，例如 `400/401/403/500`
- 业务错误码负责表达领域错误，例如 `INVALID_INVITE_CODE`
- 业务错误 message 负责表达用户可读文案

推荐错误结构：

- `status`: HTTP 状态码
- `code`: 稳定业务错误码
- `message`: 用户可读错误文案
- `data`: 可选附加数据

约束：

- 不要把 HTTP status 直接当成业务错误码使用
- 不要把底层异常文本原样透传给前端
- route 层需要把 repository / service 抛出的错误收敛成稳定的 `code + message`
- 未知异常才返回通用兜底错误

### 5.2 鉴权

需要登录的 API route，优先使用：

- `requireAuthenticatedApiRoute`
- `withAuthCookies`

定义在：

- `src/lib/supabase/route-handler.ts`

不要手写分散的 Supabase `getUser()` 鉴权逻辑。

### 5.3 API 文案

错误/提示文案统一放：

- `src/lib/http/api-messages.ts`

不要在 route handler 里散写错误字符串。

## 6. 数据源与 repository 规范

### 6.1 repository 是隔离层

任何与业务实体相关的数据访问，都应该优先放到 repository：

- `src/lib/data/projects-repository.ts`
- `src/lib/data/prompts-repository.ts`
- `src/lib/data/feed-repository.ts`
- `src/lib/data/project-conversations-repository.ts`

repository 的职责：

- 封装持久化访问
- 封装业务数据装配
- 封装领域对象组装

### 6.2 不要跨层直接操作数据源

禁止：

- 页面组件直接读底层数据源
- route handler 直接写持久化细节
- UI 直接 import mock data source

### 6.3 服务器端模块

只在服务器使用的模块，保留：

```ts
import 'server-only';
```

例如：

- repository
- 服务端 auth/session helper

## 7. React 组件规范

### 7.1 什么时候写 `'use client'`

只有在组件需要以下能力时再写：

- state
- effect
- event handler
- browser API
- React Query hooks

纯展示组件优先保持 server-compatible。

### 7.2 组件放置规则

页面私有组件：

- `src/app/.../_components/**`

通用组件：

- `src/components/**`

### 7.3 组件拆分原则

优先拆分以下内容：

- 大块交互逻辑
- 可复用 UI 片段
- 强业务状态展示块

不要为了拆分而拆分。

如果一个组件只是被单次使用且逻辑简单，保留在当前文件更好。

### 7.4 组件命名

使用 PascalCase。

示例：

- `ProjectChatSection`
- `ProjectPreviewPanel`
- `ProjectsListError`

文件名与导出名保持一致。

## 8. UI 技术栈使用规范

### 8.1 首选 Mantine

本项目的 UI 主体系是 Mantine。
当前仓库使用 Mantine 9。

处理 Mantine 组件、主题、Styles API、响应式布局、modal/notification 约定时：

- 优先使用仓库内 skill：`.agents/skills/mantine-ui/SKILL.md`
- 需要官方细节时，再按需查阅：`.agents/skills/mantine-ui/references/mantine-ui-llm.txt`
- 不要整份通读 reference，先按组件名或主题检索相关段落

优先使用：

- `@mantine/core`
- `@mantine/hooks`
- `@mantine/modals`
- `@mantine/notifications`

使用场景：

- 布局：`Box` `Stack` `Group` `Paper` `Center`
- 表单：`Textarea` `Input` `Button`
- 反馈：`Skeleton` `Loader` `Notifications`
- 弹层：Mantine modal system

### 8.2 Tailwind 的角色

Tailwind 在这里主要用于：

- 快速布局补充
- 细粒度 className 微调
- flex / width / min-height 等结构控制

不要把 Mantine 完全绕开改成纯 Tailwind 组件体系。

推荐模式：

- 结构和交互用 Mantine
- 局部布局和尺寸微调用 `className`

### 8.3 图标

统一使用：

- `react-icons`

当前主要使用：

- `react-icons/fi`
- `react-icons/hi2`

不要同时引入多个图标系统，除非当前库无法满足。

### 8.4 弹窗

统一走 Mantine modal registry：

- 组件放 `src/modals/**`
- 注册放 `src/providers/ModalProvider.tsx`

不要到处临时挂载零散 modal provider。

### 8.5 通知

统一使用：

- `showApiNotification`
- `showAppNotification`

不要手写分散的 toast 方案。

通知文案规则：

- 业务通知码统一收敛到 `src/config/notification-config.ts`
- 优先提供固定、用户可读的 `title` 和 `message`
- 前后端联动的业务报错，优先使用后端返回的 `code + message`
- query / mutation 的 `onError` 负责统一拦截 API 错误并展示通知
- 后端 `code` 用作通知 title，后端 `message` 用作通知 message
- 网络异常、超时、非法响应等非业务错误，再使用前端兜底通知文案
- 不要把底层 `error.message` 原样直接展示给用户，除非它已经是 route 层收敛后的用户文案
- 如果错误细节确实有帮助，只能追加简短错误摘要，不要让底层报错覆盖主文案
- 成功态通知也优先走统一通知配置，不要只覆盖错误态
- 跨 redirect 的通知统一通过全局通知桥接处理，不要在页面里重复解析 URL 参数

## 9. 状态管理规范

### 9.1 React Query

用于：

- 服务端数据请求
- mutation
- retry/refetch
- loading/error lifecycle

全局 provider：

- `src/providers/QueryProvider.tsx`

### 9.2 React Context

用于：

- 轻量全局客户端状态分发
- 当前认证用户信息共享

示例：

- `src/stores/authenticated-user-store.tsx`

不要把所有远程数据塞进 context。

远程请求数据优先 React Query。

### 9.3 页面级 provider

如果某个页面有复杂局部状态机，使用页面级 provider。

当前典型例子：

- `ProjectConversationProvider.tsx`

适合这种模式的场景：

- websocket / replay
- preview 与 chat 的联动
- task 状态与 UI 的复合推导

## 10. Project 页面特有约定

`project/[projectId]` 是当前最复杂的业务页面。

### 10.1 目录职责

- `chat/`：聊天区 UI
- `previews/`：右侧预览区 UI
- `header/`：project 头部
- `ProjectConversationProvider.tsx`：project 页面状态总线

### 10.2 preview 规则

preview 不单独请求接口。

preview 数据必须来自：

- chat 当前选中的 tool card
- provider 内的派生状态

不要在 preview 组件里自行拉接口。

### 10.3 project conversation 资源落点

当前 project conversation 相关落点：

- 共享类型：`src/types/project-conversation.ts`
- 运行时 replay helper：`src/lib/replay/project-conversation-replay.ts`
- `src/lib/data/project-conversations-repository.ts`

不要重新创建 `data.ts` 放回页面目录。

### 10.4 task 状态与历史

当前 project conversation 里要区分：

- 历史 timeline
- 当前会话期间的 task 状态事件

例如：

- `error`
- `cancelled`

这些状态默认不应该进入历史接口的 timeline。

## 11. 命名与文件风格

### 11.1 文件命名

- React 组件：PascalCase
- hooks：`use-*.ts` 或 `use-*.tsx`
- repository：`*-repository.ts`
- provider：`*Provider.tsx`
- API schema：放在 `src/app/api/types`

### 11.2 类型位置

优先级：

1. 被 UI / provider / repository / API schema 共同消费的共享业务类型：放在 `src/types`
2. API 入参/出参 schema 与 route 协议类型：放在 `src/app/api/types`
3. 仅当前文件或当前目录私有的局部类型：就近放在当前文件或当前目录

补充规则：

- 不要为了“离实现近”就把共享业务类型重新塞回 `src/lib/**/types.ts`
- 如果一个类型已经被多个层同时消费，应提升到 `src/types`

不要在组件文件之间互相复制类型。

### 11.3 Barrel 文件

当前通用组件目录有少量 `index.ts`。

如果是局部业务组件目录，不强制加 barrel。

优先减少不必要的导出层。

### 11.4 `camelCase` 与 `snake_case` 的使用场景

默认规则：

- React 组件 props
- hooks 入参/返回值
- 普通 TypeScript 变量
- 前端内部函数和对象字段

默认使用 `camelCase`。

适合使用 `snake_case` 的场景：

- 需要映射数据库字段命名时
- 需要贴合后端 / API / websocket 原始协议字段时
- `.env` / 环境变量语义在代码中的镜像配置时
- 明确作为“配置数据 schema”存在、并希望更接近运营/内容配置表结构时

当前仓库里的一个典型例子是：

- `src/config/app-config.ts`

这里的内容更接近“可维护的内容配置表”，不是组件 props，也不是运行时函数参数，因此允许整体使用一致的 `snake_case` 字段。

注意事项：

- 同一个对象内部不要混用 `camelCase` 和 `snake_case`
- 如果已经决定某个配置对象使用 `snake_case`，则该对象下的字段应整体保持一致
- UI 组件消费这类配置时，可以直接读取 `snake_case` 字段；不要为了局部使用又临时混出第二套命名

### 11.5 注释与 JSDoc 规范

默认原则：

- 不要写解释“代码表面行为”的废话注释
- 注释应补充函数用途、输入约束、返回语义，而不是逐行翻译实现
- 能通过更清晰的命名解决的问题，优先改名，不要依赖注释补救

对外导出的通用函数，尤其是以下位置中的函数：

- `src/utils/**`
- `src/lib/**`

优先补充 JSDoc 注释。

规范如下：

- 注释写在函数定义上方
- 第一行说明“这个方法做什么、适合在什么场景使用”
- 有入参时，使用 `@param` 描述每个参数的含义、格式或边界
- 有返回值时，使用 `@returns` 描述返回结果的语义，以及异常/兜底返回值
- 如果某个方法对时间、时区、单位、空值、非法值有特殊约束，必须在注释中明确写出

示例要求：

- 不推荐：`Formats date`
- 推荐：说明该方法用于绝对时间展示还是相对时间展示，并写清楚 `@param` 与 `@returns`

## 12. 第三方库使用建议

### 12.1 `ky`

用于 HTTP client。

不要直接在页面里裸写 `fetch` 去替代现有 `requestApiData`，除非场景非常特殊。

### 12.2 `zod`

所有 API 入参/出参都应该有 schema。

新增协议时：

- 先写 schema
- 再写类型推导与客户端消费

### 12.3 `dayjs`

用于时间格式化。

不要新引入第二套时间库。

### 12.3.1 时间与时区规则

时间处理必须统一遵循以下规则：

- 存储时间统一使用 UTC
- 数据库时间字段优先使用 `timestamptz`
- 应用层手动写入时间时，统一使用 `new Date().toISOString()`
- 不要把服务器本地时区时间直接写入数据库
- 不要把“Vercel / Node 运行时所在时区”当作业务时间基准

展示时间统一遵循以下规则：

- 前端展示时，基于后端返回的 UTC 时间做本地化转换
- 绝对时间按用户本地时区展示
- 相对时间也应基于用户当前本地时间计算
- 不要在 UI 中直接裸显示未经转换的 UTC 时间字符串，除非该场景明确需要调试信息

实现原则：

- 存储层只保证时间基准统一，不负责面向用户的本地化展示
- 展示层只负责把 UTC 时间转换为用户可理解的本地时间表达
- 新增时间相关逻辑时，先确认“这是存储时间，还是展示时间”，不要混用

### 12.4 Supabase

当前用于认证和后续服务端切换。

不要在客户端分散初始化多个 Supabase client。

## 13. 新增代码的推荐工作流

新增功能时建议按这个顺序：

1. 确认它属于页面层、通用组件层、API 层，还是 repository 层
2. 如果涉及协议，先写 `src/app/api/types/*`
3. 如果涉及业务数据，先写 `src/lib/data/*` 或领域 `src/lib/*`
4. 再写 API route
5. 再写页面 provider / query hook
6. 最后接 UI
7. 跑 `tsc` 和 `eslint`

如果涉及 API 错误处理，再额外确认：

1. route 是否返回稳定 `code + message`
2. `src/querys` 中的 hook 是否在 `onError` 统一处理
3. UI 是否只处理表单字段错误和本地交互错误，不重复拼通知

## 14. 校验与完成标准

提交前至少执行：

```bash
pnpm exec tsc --noEmit --pretty false
pnpm exec eslint src --ext .ts,.tsx
```

如果改动较大，建议再执行：

```bash
pnpm exec prettier --write <changed-files>
```

## 15. 明确禁止的做法

不要做这些事情：

- 在页面目录重新引入静态 `data.ts` 作为 UI 数据源
- 在运行时代码中引入或拼装 mock 数据
- 在 API route 中写复杂持久化细节 / 复杂状态机
- 在 preview 组件中自行请求接口
- 在 `src/querys` 之外直接发远程请求
- 绕过 `requestApiData` 和 Zod schema
- 让页面组件自己决定 API 业务错误的通知拼装方式
- 直接向前端透传底层异常字符串作为 API 业务错误
- 新增另一套 UI 体系替代 Mantine
- 把远程请求状态塞到 Zustand 里取代 React Query
- 用多个不同的通知/弹窗方案并存
- 在 repository / route handler / provider 中继续保留本地 mock 分支
- 把共享业务类型继续散落到多个页面或 `src/lib/**/types.ts`

## 16. 如果 agent 不确定该放哪里

按下面优先级判断：

1. 和页面强绑定的 UI：当前页面 `_components`
2. 多页面复用 UI：`src/components`
3. 全局配置 / 主题 / 菜单 / 通知配置：`src/config`
4. 轻量可复用客户端行为：`src/hooks`
5. 业务逻辑 / repository / replay / 通知实现：`src/lib`
6. API 协议：`src/app/api/types`
7. 远程请求 hook：`src/querys`
8. 全局客户端状态：`src/stores`

如果一个需求同时涉及 UI、状态和 API，不要把逻辑都塞进一个组件文件里。优先保持分层。
