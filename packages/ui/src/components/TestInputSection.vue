<template>
  <div>
    <NSpace vertical :size="8">
      <template v-if="showTextInput">
        <!-- 标题和控制区域 -->
        <NFlex justify="space-between" align="center" :wrap="false">
          <NText :depth="2" style="font-size: 14px; font-weight: 500;">
            {{ label }}
          </NText>
          <NButton
            v-if="enableFullscreen"
            type="tertiary"
            size="small"
            @click="openFullscreen"
            :title="t('common.expand')"
            ghost
            round
          >
            <template #icon>
              <NIcon>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                </svg>
              </NIcon>
            </template>
          </NButton>
        </NFlex>

        <!-- 输入区域 -->
        <NInput
          :value="modelValue"
          @update:value="$emit('update:modelValue', $event)"
          type="textarea"
          :placeholder="placeholder"
          :disabled="disabled"
          :autosize="autosizeConfig"
          clearable
          show-count
          :size="size"
        />

        <!-- 帮助文本 -->
        <NText v-if="helpText" :depth="3" style="font-size: 12px;">
          {{ helpText }}
        </NText>
      </template>

      <!-- 图片输入 -->
      <NFlex v-if="showImageInput" vertical :size="8">
        <NText :depth="2" style="font-size: 13px; font-weight: 500;">
          {{ t('test.image.label') }}
        </NText>
        <NFlex align="center" :size="8" :wrap="true">
          <NUpload
            v-model:file-list="uploadFileList"
            :default-upload="false"
            :max="1"
            :multiple="false"
            accept="image/*"
            :disabled="disabled"
            @change="handleUploadChange"
          >
            <NButton :size="size" :disabled="disabled">
              {{ t('test.image.upload') }}
            </NButton>
          </NUpload>
          <NText :depth="3" style="font-size: 12px;">
            {{ t('test.image.or') }}
          </NText>
          <NInput
            v-model:value="imageUrlInput"
            :size="size"
            clearable
            :disabled="disabled"
            :placeholder="t('test.image.urlPlaceholder')"
            @blur="handleUrlValidate"
          />
          <NButton
            :size="size"
            :disabled="disabled || !imageUrlInput.trim()"
            @click="handleUrlValidate"
          >
            {{ t('test.image.urlCheck') }}
          </NButton>
        </NFlex>
        <NText
          v-if="imageStatusMessage"
          :type="imageStatusType"
          style="font-size: 12px;"
        >
          {{ imageStatusMessage }}
        </NText>
        <NFlex
          v-if="imagePreviewUrl"
          align="center"
          :size="8"
          :wrap="true"
        >
          <NImage
            :src="imagePreviewUrl"
            :preview-disabled="true"
            style="max-width: 160px; max-height: 120px; border-radius: 6px;"
            object-fit="contain"
          />
          <NButton
            :size="size"
            type="tertiary"
            :disabled="disabled"
            @click="clearImage"
          >
            {{ t('test.image.clear') }}
          </NButton>
        </NFlex>
      </NFlex>
    </NSpace>

    <!-- 全屏弹窗 -->
    <FullscreenDialog v-if="enableFullscreen && showTextInput" v-model="isFullscreen" :title="label">
      <NInput
        v-model:value="fullscreenValue"
        type="textarea"
        :placeholder="placeholder"
        :autosize="{ minRows: 20 }"
        clearable
        show-count
      />
    </FullscreenDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { useI18n } from 'vue-i18n'
import { NSpace, NFlex, NText, NButton, NIcon, NInput, NUpload, NImage } from 'naive-ui'
import type { UploadFileInfo, UploadChangeParam } from 'naive-ui'
import { useFullscreen } from '../composables/ui/useFullscreen'
import FullscreenDialog from './FullscreenDialog.vue'
import type { TestImagePayload } from './types/test-area'

const { t } = useI18n()

interface Props {
  modelValue: string
  label: string
  placeholder?: string
  helpText?: string
  imageValue?: TestImagePayload | null
  disabled?: boolean
  size?: 'small' | 'medium' | 'large'
  mode?: 'compact' | 'normal'
  enableFullscreen?: boolean
  minRows?: number
  maxRows?: number
  showTextInput?: boolean
  showImageInput?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  helpText: '',
  disabled: false,
  size: 'medium',
  mode: 'normal',
  enableFullscreen: true,
  minRows: 3,
  maxRows: 8,
  showTextInput: true,
  showImageInput: true
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:imageValue': [value: TestImagePayload | null]
}>()

const showTextInput = computed(() => props.showTextInput)
const showImageInput = computed(() => props.showImageInput)

// autosize 配置
const autosizeConfig = computed(() => {
  const baseConfig = {
    minRows: props.mode === 'compact' ? Math.max(2, props.minRows - 1) : props.minRows,
    maxRows: props.mode === 'compact' ? Math.max(4, props.maxRows - 2) : props.maxRows
  }
  
  return baseConfig
})

const imageUrlInput = ref('')
const imageStatus = ref<'idle' | 'checking' | 'loading' | 'valid' | 'invalid'>('idle')
const imageError = ref('')
const uploadFileList = ref<UploadFileInfo[]>([])
const urlValidationToken = ref(0)

const imagePreviewUrl = computed(() => props.imageValue?.url || '')

const imageStatusType = computed(() => {
  if (imageStatus.value === 'invalid') return 'error'
  if (imageStatus.value === 'valid') return 'success'
  if (imageStatus.value === 'checking') return 'info'
  if (imageStatus.value === 'loading') return 'info'
  return 'default'
})

const imageStatusMessage = computed(() => {
  if (imageStatus.value === 'checking') return t('test.image.urlChecking')
  if (imageStatus.value === 'loading') return t('test.image.fileLoading')
  if (imageStatus.value === 'invalid') return imageError.value || t('test.image.urlInvalid')
  if (imageStatus.value === 'valid') {
    return props.imageValue?.sourceType === 'file'
      ? t('test.image.fileReady')
      : t('test.image.urlValid')
  }
  return ''
})

const emitImageValue = (payload: TestImagePayload | null) => {
  emit('update:imageValue', payload)
}

const resetImageState = () => {
  imageStatus.value = 'idle'
  imageError.value = ''
  emitImageValue(null)
}

const clearImage = () => {
  urlValidationToken.value += 1
  imageUrlInput.value = ''
  uploadFileList.value = []
  resetImageState()
}

const handleUploadChange = (options: UploadChangeParam) => {
  const fileEntry = options.fileList[0]?.file
  if (!fileEntry) {
    resetImageState()
    return
  }

  urlValidationToken.value += 1
  if (fileEntry.type && !fileEntry.type.startsWith('image/')) {
    imageStatus.value = 'invalid'
    imageError.value = t('test.image.fileInvalid')
    emitImageValue(null)
    return
  }

  imageStatus.value = 'loading'
  imageError.value = ''
  imageUrlInput.value = ''

  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    imageStatus.value = 'valid'
    imageError.value = ''
    emitImageValue({
      sourceType: 'file',
      url: dataUrl,
      name: fileEntry.name,
      isValid: true
    })
  }
  reader.onerror = () => {
    imageStatus.value = 'invalid'
    imageError.value = t('test.image.fileReadError')
    emitImageValue(null)
  }
  reader.readAsDataURL(fileEntry)
}

const handleUrlValidate = async () => {
  const url = imageUrlInput.value.trim()
  uploadFileList.value = []

  if (!url) {
    resetImageState()
    return
  }

  if (url.startsWith('data:')) {
    imageStatus.value = 'valid'
    imageError.value = ''
    emitImageValue({
      sourceType: 'url',
      url,
      isValid: true
    })
    return
  }

  if (!/^https?:\/\//i.test(url)) {
    imageStatus.value = 'invalid'
    imageError.value = t('test.image.urlInvalid')
    emitImageValue(null)
    return
  }

  const currentToken = ++urlValidationToken.value
  imageStatus.value = 'checking'
  imageError.value = ''

  const image = new Image()
  image.onload = () => {
    if (currentToken !== urlValidationToken.value) return
    imageStatus.value = 'valid'
    imageError.value = ''
    emitImageValue({
      sourceType: 'url',
      url,
      isValid: true
    })
  }
  image.onerror = () => {
    if (currentToken !== urlValidationToken.value) return
    imageStatus.value = 'invalid'
    imageError.value = t('test.image.urlUnreachable')
    emitImageValue(null)
  }
  image.referrerPolicy = 'no-referrer'
  image.src = url
}

watch(
  () => props.imageValue,
  (value) => {
    if (!value) return
    if (value.sourceType === 'url' && value.url !== imageUrlInput.value) {
      imageUrlInput.value = value.url
      imageStatus.value = value.isValid ? 'valid' : 'invalid'
      imageError.value = value.error || ''
    }
    if (value.sourceType === 'file') {
      imageStatus.value = value.isValid ? 'valid' : 'invalid'
      imageError.value = value.error || ''
    }
  }
)

watch(imageUrlInput, (value) => {
  const trimmed = value.trim()
  if (props.imageValue?.sourceType === 'url' && trimmed !== props.imageValue.url) {
    imageStatus.value = 'idle'
    imageError.value = ''
    emitImageValue(null)
  }
  if (props.imageValue?.sourceType === 'file' && trimmed) {
    uploadFileList.value = []
    imageStatus.value = 'idle'
    imageError.value = ''
    emitImageValue(null)
  }
})

// 全屏功能
const { isFullscreen, fullscreenValue, openFullscreen } = useFullscreen(
  computed(() => props.modelValue),
  (value) => emit('update:modelValue', value)
)
</script>
