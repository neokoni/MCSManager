<script setup lang="ts">
import type { FormInstance } from "ant-design-vue";
import { ref } from "vue";
import { t } from "@/lang/i18n";
import {
  AppstoreAddOutlined,
  BlockOutlined,
  FileZipOutlined,
  FolderOpenOutlined
} from "@ant-design/icons-vue";
import CardPanel from "@/components/CardPanel.vue";
import CreateInstanceForm from "@/widgets/setupApp/CreateInstanceForm.vue";
import { QUICKSTART_METHOD } from "@/hooks/widgets/quickStartFlow";
import { openNodeSelectDialog } from "@/components/fc";
import { router } from "@/config/router";

const formRef = ref<FormInstance>();

const daemonId = "";

// 表单数据状态
const formData = ref({
  createMethod: QUICKSTART_METHOD.DOCKER,
  daemonId: daemonId || ""
});

// 弹窗状态
const showCreateInstanceForm = ref(false);

const handleNext = (instanceUuid: string) => {
  showCreateInstanceForm.value = false;
  // 创建成功后跳转到实例终端页面
  router.push({
    path: "/instances/terminal",
    query: {
      daemonId: formData.value.daemonId,
      instanceId: instanceUuid
    }
  });
};

const handleInstallAction = async (createMethod: QUICKSTART_METHOD) => {
  formData.value.createMethod = createMethod;

  try {
    const selectedNode = await openNodeSelectDialog();
    if (!selectedNode) return;
    formData.value.daemonId = selectedNode.uuid;
    showCreateInstanceForm.value = true;
  } catch (error) {
    console.error(error);
  }
};

const manualInstallOptions = [
  {
    label: t("TXT_CODE_a3efb1cc"),
    icon: FileZipOutlined,
    description: t("TXT_CODE_f09da050"),
    action: (e: Event) => {
      handleInstallAction(QUICKSTART_METHOD.IMPORT);
      e.preventDefault();
    }
  },
  {
    label: t("TXT_CODE_bae487e4"),
    icon: BlockOutlined,
    description: t("TXT_CODE_256e5825"),
    action: (e: Event) => {
      handleInstallAction(QUICKSTART_METHOD.DOCKER);
      e.preventDefault();
    }
  },
  {
    label: t("TXT_CODE_e0fca76"),
    icon: FolderOpenOutlined,
    description: t("TXT_CODE_b3844cf8"),
    action: (e: Event) => {
      handleInstallAction(QUICKSTART_METHOD.EXIST);
      e.preventDefault();
    }
  }
];
</script>

<template>
  <div style="text-align: left">
    <a-form ref="formRef" layout="vertical" autocomplete="off">
      <a-typography-title :level="4" style="margin-bottom: 8px">
        <AppstoreAddOutlined />
        {{ t("TXT_CODE_5a74975b") }}
      </a-typography-title>
      <a-typography-paragraph>
        <p>
          {{ t("TXT_CODE_81ad9e80") }}
        </p>
      </a-typography-paragraph>
      <div class="manual-install-options">
        <a-row :gutter="[16, 16]">
          <a-col v-for="(option, index) in manualInstallOptions" :key="index" :span="24">
            <CardPanel class="install-option-card">
              <template #title>
                <div class="card-header">
                  <div class="card-title">{{ option.label }}</div>
                </div>
              </template>
              <template #body>
                <div class="icon-wrapper">
                  <component :is="option.icon" />
                </div>
                <div class="card-description">
                  {{ option.description }}
                </div>

                <div class="card-action">
                  <a-button type="primary" @click="option.action">
                    <div class="flex items-center">
                      {{ t("TXT_CODE_7b2c5414") }}
                    </div>
                  </a-button>
                </div>
              </template>
            </CardPanel>
          </a-col>
        </a-row>
      </div>
    </a-form>
  </div>
  <!-- 创建实例表单弹窗 -->
  <a-modal
    v-model:open="showCreateInstanceForm"
    :title="t('TXT_CODE_645bc545')"
    :width="800"
    :footer="null"
    :destroy-on-close="true"
  >
    <CreateInstanceForm
      :create-method="formData.createMethod"
      :daemon-id="formData.daemonId"
      @next-step="handleNext"
    />
  </a-modal>
</template>

<style lang="scss" scoped>
.CardWrapper {
  min-height: 500px;
}

.btn-area {
  position: absolute;
  bottom: 16px;
  right: 16px;
}

.manual-install-options {
  margin: 24px auto;
}

.install-option-card {
  cursor: pointer;
  transition: all 0.3s ease;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;

  &:hover {
    transform: translateY(-4px);

    &::before {
      opacity: 1;
    }
  }

  .card-header {
    display: flex;
    align-items: center;

    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--color-gray-10);
      flex: 1;
    }
  }

  .card-description {
    color: var(--color-gray-8);
    font-size: 14px;
    line-height: 1.5;
    margin-bottom: 16px;
    flex: 1;
  }

  .card-action {
    display: flex;
    justify-content: flex-end;
    color: var(--color-blue-6);
    font-size: 14px;
    gap: 4px;
    margin-right: 4px;
  }

  .icon-wrapper {
    position: absolute;
    left: 2px;
    bottom: 0;
    color: var(--color-gray-8);
    opacity: 0.2;
    font-size: 20px;
    transform: rotate(-1deg);
  }
}
</style>
