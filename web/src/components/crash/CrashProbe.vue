<script lang="ts">
// 渲染兜底测试探针（P-20261002-26）：?__crash=1 专用「渲染必抛」组件，
// 供 e2e/dev 验证降级路径。激活条件在 App.vue：本机主机名守卫
// （localhost/127.0.0.1/[::1]）+ 显式查询参数——e2e 走 go:embed 生产构建
// 无法用 import.meta.env.DEV 守卫；远端实例经非本机地址访问时探针不激活，
// 兜底本体（errorHandler/降级页）全环境生效不受此守卫影响。
// App 层完全挂载后才武装探针（onMounted），捕获其错误后 bump :key 促使其
// 连续重渲染抛错直至熔断阈值——走与生产完全相同的 crashGuard 判定链路
import { defineComponent } from 'vue'

/** 探针错误标记：错误消息前缀，e2e/日志据此识别模拟崩溃（非真实缺陷） */
export const CRASH_PROBE_MARKER = '__crash-probe'

/** 渲染必抛（never 返回）：每次被调用都抛出模拟崩溃错误 */
function boomRender(): never {
  throw new Error(`${CRASH_PROBE_MARKER}: 模拟组件渲染崩溃（e2e/dev 专用探针）`)
}

export default defineComponent({
  name: 'CrashProbe',
  render: boomRender,
})
</script>
