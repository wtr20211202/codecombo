import { defineAsyncComponent, type Component } from 'vue'
import AsyncLoadError from '@/components/layout/AsyncLoadError.vue'

// defineAsyncComponent 默认在动态 chunk 拉取失败时只渲染空注释（长寿命页面中
// 并不罕见：构建产物哈希变更、网络瞬断、标签休眠后恢复等），用户面对的是
// 一块没有任何解释的空白。这里统一包装：
//   1. 自动重试 2 次，吸收瞬断；
//   2. 仍失败则渲染 AsyncLoadError 卡片；卡片上的「重试」经 fallthrough 的
//      @retry 监听通知调用方——调用方递增绑定在组件上的 :key 触发重新挂载，
//      defineAsyncComponent 的新实例会再次执行 loader（成功前不缓存）。
export function safeAsync<T extends Component>(loader: () => Promise<T>) {
  return defineAsyncComponent({
    loader,
    onError: (err, retry, fail, attempts) => {
      if (attempts <= 2) retry()
      else fail()
    },
    errorComponent: AsyncLoadError,
  })
}
